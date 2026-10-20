package hostlaunch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// TestHostlaunchChildProcess 只在隔离子进程中扮演 Host；不读取用户数据或启动真实 Host。
func TestHostlaunchChildProcess(t *testing.T) {
	mode := os.Getenv("HOSTLAUNCH_TEST_CHILD")
	if mode == "" {
		return
	}
	home := os.Getenv("DSH_HOME")
	var termination chan os.Signal
	if mode == "ignore-term" {
		signal.Ignore(syscall.SIGTERM)
	} else if mode == "remove-record-on-term" {
		termination = make(chan os.Signal, 1)
		signal.Notify(termination, syscall.SIGTERM)
	}
	if err := os.WriteFile(filepath.Join(home, "child.pid"), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		os.Exit(2)
	}
	if mode != "no-ready" {
		port, _ := strconv.Atoi(os.Getenv("HOSTLAUNCH_TEST_PORT"))
		record := Record{Type: "coding-host-ready", Port: port, PID: os.Getpid(), Version: "dev", Protocol: Protocol, Token: "owned-token"}
		if mode == "wrong-pid" {
			record.PID++
		} else if mode == "invalid-record" {
			record.Protocol++
		}
		data, _ := json.Marshal(record)
		if err := os.WriteFile(filepath.Join(home, "host.json"), data, 0o600); err != nil {
			os.Exit(2)
		}
		fmt.Println(string(data))
	}
	if mode == "output-after-ready" {
		fmt.Println(strings.Repeat("drain", 1<<20))
		if err := os.WriteFile(filepath.Join(home, "output-drained"), nil, 0o600); err != nil {
			os.Exit(2)
		}
	}
	if termination != nil {
		<-termination
		_ = os.Remove(filepath.Join(home, "host.json"))
	}
	time.Sleep(30 * time.Second)
	os.Exit(0)
}

func ownedTestLauncher(t *testing.T, mode, healthToken string) *Launcher {
	t.Helper()
	server := httptest.NewServer(hostDescribeHandler("dev", healthToken))
	t.Cleanup(server.Close)
	port, err := strconv.Atoi(server.URL[len("http://127.0.0.1:"):])
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	launcher, err := New(Options{
		Home: home, CWD: home, Version: "dev", StartupTimeout: 3 * time.Second,
		Command: []string{os.Args[0], "-test.run=^TestHostlaunchChildProcess$"},
		Environment: map[string]string{
			"HOME": home, "HOSTLAUNCH_TEST_CHILD": mode, "HOSTLAUNCH_TEST_PORT": strconv.Itoa(port),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, owned := range launcher.owned {
			_ = owned.signal(os.Kill)
			<-owned.done
		}
	})
	return launcher
}

func TestEnsureRejectsWrongChildPID(t *testing.T) {
	launcher := ownedTestLauncher(t, "wrong-pid", "owned-token")
	if _, err := launcher.Ensure(context.Background()); err == nil {
		t.Fatal("Ensure accepted readiness from a PID other than its child")
	}
	assertChildExited(t, launcher)
}

func TestEnsureReapsChildAfterHealthFailure(t *testing.T) {
	launcher := ownedTestLauncher(t, "good", "different-token")
	if _, err := launcher.Ensure(context.Background()); err == nil {
		t.Fatal("Ensure accepted a mismatched health token")
	}
	assertChildExited(t, launcher)
}

func TestEnsureReapsChildAfterInvalidReadiness(t *testing.T) {
	launcher := ownedTestLauncher(t, "invalid-record", "owned-token")
	if _, err := launcher.Ensure(context.Background()); err == nil {
		t.Fatal("Ensure accepted an invalid protocol")
	}
	assertChildExited(t, launcher)
}

func TestEnsureReapsChildAfterCancellation(t *testing.T) {
	launcher := ownedTestLauncher(t, "no-ready", "owned-token")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := launcher.Ensure(ctx)
		done <- err
	}()
	waitForFixtureFile(t, filepath.Join(launcher.Home(), "child.pid"))
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Ensure error = %v, want canceled", err)
	}
	assertChildExited(t, launcher)
}

func TestEnsureReapsChildAfterReadinessTimeout(t *testing.T) {
	launcher := ownedTestLauncher(t, "no-ready", "owned-token")
	launcher.options.StartupTimeout = 300 * time.Millisecond
	if _, err := launcher.Ensure(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Ensure error = %v, want deadline", err)
	}
	assertChildExited(t, launcher)
}

func TestEnsureDrainsOutputAfterReadiness(t *testing.T) {
	launcher := ownedTestLauncher(t, "output-after-ready", "owned-token")
	if _, err := launcher.Ensure(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitForFixtureFile(t, filepath.Join(launcher.Home(), "output-drained"))
}

func TestStopOwnedStopsAndReapsOriginalChildIdempotently(t *testing.T) {
	launcher := ownedTestLauncher(t, "good", "owned-token")
	endpoint, err := launcher.Ensure(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var stopping sync.WaitGroup
	for range 8 {
		stopping.Add(1)
		go func() {
			defer stopping.Done()
			if err := launcher.StopOwned(context.Background(), endpoint); err != nil {
				t.Errorf("StopOwned: %v", err)
			}
		}()
	}
	stopping.Wait()
	assertChildExited(t, launcher)
	if err := launcher.StopOwned(context.Background(), endpoint); err != nil {
		t.Fatal(err)
	}
}

func TestStopOwnedDoesNotStopOtherLaunchersChild(t *testing.T) {
	owner := ownedTestLauncher(t, "good", "owned-token")
	endpoint, err := owner.Ensure(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	other, err := New(Options{Home: owner.Home(), CWD: owner.Home()})
	if err != nil {
		t.Fatal(err)
	}
	if err := other.StopOwned(context.Background(), endpoint); !errors.Is(err, ErrHostNotOwned) {
		t.Fatalf("StopOwned error = %v, want not owned", err)
	}
	attached, err := other.Ensure(context.Background())
	if err != nil || attached.Started {
		t.Fatalf("attach endpoint = %#v, error = %v", attached, err)
	}
	if err := other.StopOwned(context.Background(), attached); err != nil {
		t.Fatal(err)
	}
	if !processAlive(endpoint.Record.PID) {
		t.Fatal("non-owning launcher stopped another launcher's child")
	}
}

func TestStopOwnedRefusesAlteredEndpoint(t *testing.T) {
	launcher := ownedTestLauncher(t, "good", "owned-token")
	endpoint, err := launcher.Ensure(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	altered := endpoint
	altered.Record.Token = "different-token"
	if err := launcher.StopOwned(context.Background(), altered); !errors.Is(err, ErrHostNotOwned) {
		t.Fatalf("StopOwned error = %v, want not owned", err)
	}
	if !processAlive(endpoint.Record.PID) {
		t.Fatal("an altered endpoint stopped the original child")
	}
}

func TestStopOwnedRefusesReplacedRecord(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		change func(*Record)
	}{
		{name: "PID", change: func(record *Record) { record.PID++ }},
		{name: "token", change: func(record *Record) { record.Token = "successor-token" }},
		{name: "port", change: func(record *Record) { record.Port++ }},
		{name: "version", change: func(record *Record) { record.Version = "successor" }},
		{name: "protocol", change: func(record *Record) { record.Protocol++ }},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			launcher := ownedTestLauncher(t, "good", "owned-token")
			endpoint, err := launcher.Ensure(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			replacement := endpoint.Record
			testCase.change(&replacement)
			writeFixtureRecord(t, launcher, replacement)
			if err := launcher.StopOwned(context.Background(), endpoint); !errors.Is(err, ErrHostIdentityChanged) {
				t.Fatalf("StopOwned error = %v, want changed identity", err)
			}
			if !processAlive(endpoint.Record.PID) {
				t.Fatal("replacement record allowed an old endpoint to stop a Host")
			}
		})
	}
}

func TestStopOwnedDoesNotStopSuccessorFromReplacedRecord(t *testing.T) {
	original := ownedTestLauncher(t, "good", "owned-token")
	oldEndpoint, err := original.Ensure(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	successor := ownedTestLauncher(t, "good", "owned-token")
	newEndpoint, err := successor.Ensure(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	writeFixtureRecord(t, original, newEndpoint.Record)
	if err := original.StopOwned(context.Background(), oldEndpoint); !errors.Is(err, ErrHostIdentityChanged) {
		t.Fatalf("StopOwned error = %v, want changed identity", err)
	}
	if !processAlive(newEndpoint.Record.PID) || !processAlive(oldEndpoint.Record.PID) {
		t.Fatal("replacement discovery record caused a Host to be terminated")
	}
	_ = original.owned[oldEndpoint].signal(os.Kill)
	<-original.owned[oldEndpoint].done
	if err := original.StopOwned(context.Background(), oldEndpoint); err != nil {
		t.Fatalf("already-exited original child: %v", err)
	}
	if !processAlive(newEndpoint.Record.PID) {
		t.Fatal("already-exited original child caused successor to be terminated")
	}
}

func TestStopOwnedRefusesChangedHealthIdentity(t *testing.T) {
	launcher := ownedTestLauncher(t, "good", "owned-token")
	endpoint, err := launcher.Ensure(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(hostDescribeHandler("dev", "different-token"))
	t.Cleanup(server.Close)
	launcher.client = &http.Client{Transport: rewriteFixtureTransport{baseURL: server.URL}}
	if err := launcher.StopOwned(context.Background(), endpoint); !errors.Is(err, ErrHostIdentityChanged) {
		t.Fatalf("StopOwned error = %v, want changed identity", err)
	}
	if !processAlive(endpoint.Record.PID) {
		t.Fatal("mismatched health identity allowed the original child to be stopped")
	}
}

type rewriteFixtureTransport struct{ baseURL string }

func (transport rewriteFixtureTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	rewritten := request.Clone(request.Context())
	urlCopy := *request.URL
	rewritten.URL = &urlCopy
	rewritten.URL.Host = strings.TrimPrefix(transport.baseURL, "http://")
	return http.DefaultTransport.RoundTrip(rewritten)
}

func TestStopOwnedRechecksRecordAfterHealthResponse(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		emptyRecord bool
	}{
		{name: "replacement token"},
		{name: "missing identity fields", emptyRecord: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			launcher := ownedTestLauncher(t, "good", "owned-token")
			endpoint, err := launcher.Ensure(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			launcher.client = &http.Client{Transport: replaceRecordFixtureTransport{
				replace: func() {
					if testCase.emptyRecord {
						if err := os.WriteFile(launcher.RecordPath(), []byte("{}"), 0o600); err != nil {
							t.Fatal(err)
						}
						return
					}
					replacement := endpoint.Record
					replacement.Token = "successor-token"
					writeFixtureRecord(t, launcher, replacement)
				},
			}}
			if err := launcher.StopOwned(context.Background(), endpoint); !errors.Is(err, ErrHostIdentityChanged) {
				t.Fatalf("StopOwned error = %v, want changed identity", err)
			}
			if !processAlive(endpoint.Record.PID) {
				t.Fatal("record replaced during the health request allowed a stop signal")
			}
		})
	}
}

type replaceRecordFixtureTransport struct{ replace func() }

func (transport replaceRecordFixtureTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := http.DefaultTransport.RoundTrip(request)
	transport.replace()
	return response, err
}

func TestStopOwnedHonorsDeadlineWithoutKilling(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no graceful TERM signal")
	}
	launcher := ownedTestLauncher(t, "ignore-term", "owned-token")
	endpoint, err := launcher.Ensure(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := launcher.StopOwned(ctx, endpoint); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("StopOwned error = %v, want deadline", err)
	}
	if !processAlive(endpoint.Record.PID) {
		t.Fatal("StopOwned force-killed before the graceful shutdown interval elapsed")
	}
}

func TestStopOwnedForceKillsOriginalChildAfterItRemovesRecord(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no graceful TERM signal")
	}
	launcher := ownedTestLauncher(t, "remove-record-on-term", "owned-token")
	endpoint, err := launcher.Ensure(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := launcher.StopOwned(context.Background(), endpoint); err != nil {
		t.Fatal(err)
	}
	assertChildExited(t, launcher)
	if _, err := os.Stat(launcher.RecordPath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("record was not removed after TERM: %v", err)
	}
}

func writeFixtureRecord(t *testing.T, launcher *Launcher, record Record) {
	t.Helper()
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(launcher.RecordPath(), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func waitForFixtureFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(time.Millisecond)
	defer poll.Stop()
	for {
		if _, err := os.Stat(path); err == nil {
			return
		}
		select {
		case <-poll.C:
		case <-deadline.C:
			t.Fatalf("timed out waiting for child fixture file %s", path)
		}
	}
}

func assertChildExited(t *testing.T, launcher *Launcher) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(launcher.Home(), "child.pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(string(data))
	if err != nil {
		t.Fatal(err)
	}
	if processAlive(pid) {
		t.Fatalf("original Host child %d was not stopped and reaped", pid)
	}
}
