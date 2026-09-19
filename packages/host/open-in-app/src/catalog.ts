/**
 * open-in-app 应用 catalog：每个可启动应用按平台声明有序 launcher 来源。
 * 本文件只保存数据；平台解析位于 `resolver.ts`，图标提取位于 `icons.ts`。
 * 未声明条目的平台解析为空 catalog。
 */

/** catalog 支持的平台；其它 Host 平台解析为空。 */
export type OpenInAppPlatform = 'darwin' | 'win32' | 'linux'

/** 在启动参数中承载工作区目录的 token，例如 `--cd={path}`。 */
export const PATH_TOKEN = '{path}'

/**
 * 已解析应用接收工作区目录的方式。`argv` 会 detached 派生 launcher，并把目录
 * 替换进参数或追加到末尾；显式环境覆盖清理过凭据的父环境。`windowsHide`
 * 只供会另行打开可见 GUI 的 CLI helper 使用。`shell-open` 经
 * `dsh-native-command` 路径打开器交给 OS 默认目录动作；文件管理器使用该
 * 通道，因为直接派生 `explorer.exe <dir>` 不能可靠抬起窗口。
 */
export type OpenInAppLaunch =
  | {
    readonly kind: 'argv'
    readonly command: string
    readonly args: readonly string[]
    readonly env?: Readonly<Record<string, string>> | undefined
    readonly windowsHide?: boolean | undefined
  }
  | { readonly kind: 'shell-open' }

/**
 * 单个平台如何得到已验证 launcher。每个 locator 都解析到 Host 实际持有的
 * `.app`、磁盘可执行文件或 PATH 结果，绝不信任裸安装记录：`fixed` 随 OS
 * 提供；`app` 检查已知 `.app` 目录；`xcode` 跟随 `xcode-select -p`；
 * `cli` 经 subprocess 在进程内解析 PATH/PATHEXT；`file` 取首个现存候选；
 * `scan` 取最新版本化安装目录；`app-paths` 与 `install-record` 读取并验证
 * Windows 注册表；`github-desktop` 同时解析版本化可执行文件和自带 CLI；
 * `desktop` 读取 Linux XDG desktop entry 并验证 `TryExec`／`Exec`。
 */
export type OpenInAppLocator =
  | {
    readonly kind: 'fixed'
    readonly launch: OpenInAppLaunch
    /** 图标来源模板：macOS 为 `.app` 目录，Windows 为可执行文件。 */
    readonly iconPath: string
  }
  | { readonly kind: 'app'; readonly fsNames: readonly string[] }
  | { readonly kind: 'xcode' }
  | {
    readonly kind: 'cli'
    readonly name: string
    readonly args: readonly string[]
    /** 只有存在桌面会话时才提供该原生 GUI launcher。 */
    readonly requiresDesktop?: boolean | undefined
  }
  | { readonly kind: 'file'; readonly candidates: readonly string[]; readonly args: readonly string[] }
  | {
    readonly kind: 'scan'
    readonly root: string
    readonly namePrefix: string
    readonly relativeLauncher: string
    readonly args: readonly string[]
  }
  | { readonly kind: 'app-paths'; readonly exe: string; readonly args: readonly string[] }
  | {
    readonly kind: 'install-record'
    readonly displayNamePrefix: string
    /** `InstallLocation` 下的 launcher；省略时使用记录的 `DisplayIcon` 可执行文件。 */
    readonly relativeLauncher?: string | undefined
    readonly args: readonly string[]
  }
  | { readonly kind: 'github-desktop'; readonly root: string }
  | { readonly kind: 'desktop'; readonly desktopId: string; readonly args: readonly string[] }

/** 单个平台的 launcher 来源，以及 Linux 上拥有图标的 desktop entry。 */
export interface OpenInAppPlatformSpec {
  /** 按顺序尝试；首个产出已验证 launcher 的 locator 胜出。 */
  readonly locators: readonly OpenInAppLocator[]
  /**
   * 其 `Icon=` 键命名应用图标的 XDG desktop-entry id。仅供 Linux；macOS
   * 从已解析 bundle 取图标，Windows 从已解析可执行文件取图标。
   */
  readonly desktopId?: string
}

/** 一个可启动应用及可提供它的平台。 */
export interface OpenInAppApp {
  readonly id: string
  readonly platforms: Readonly<Partial<Record<OpenInAppPlatform, OpenInAppPlatformSpec>>>
}

/** 在已知应用目录检查指定 bundle 的 macOS spec。 */
function macApp(...fsNames: string[]): OpenInAppPlatformSpec {
  return { locators: [{ kind: 'app', fsNames }] }
}

/** 只含 locator 链、不声明 desktop 图标的 spec。 */
function spec(...locators: OpenInAppLocator[]): OpenInAppPlatformSpec {
  return { locators }
}

/** locator 链加 Linux 图标 desktop entry 的 spec。 */
function desktopSpec(desktopId: string, ...locators: OpenInAppLocator[]): OpenInAppPlatformSpec {
  return { locators, desktopId }
}

/** 在进程内解析 PATH 名称并启动结果的 locator。 */
function cli(name: string, ...args: string[]): OpenInAppLocator {
  return { kind: 'cli', name, args }
}

/** 只有桌面会话存在时才有意义的进程内 PATH locator。 */
function desktopCli(name: string, ...args: string[]): OpenInAppLocator {
  return { kind: 'cli', name, args, requiresDesktop: true }
}

/** 启动首个现存候选文件的 locator。 */
function file(candidates: string[], ...args: string[]): OpenInAppLocator {
  return { kind: 'file', candidates, args }
}

/** 按可执行文件名读取 Windows `App Paths` 的 locator。 */
function appPaths(exe: string, ...args: string[]): OpenInAppLocator {
  return { kind: 'app-paths', exe, args }
}

/** 通过目标可执行文件验证 Windows Uninstall 记录的 locator。 */
function installRecord(displayNamePrefix: string, relativeLauncher?: string, ...args: string[]): OpenInAppLocator {
  return { kind: 'install-record', displayNamePrefix, relativeLauncher, args }
}

/**
 * JetBrains 产品条目：macOS 使用已知 bundle 名；Windows 使用
 * `%ProgramFiles%\JetBrains` 下最新版本或已验证 Uninstall 记录；Linux
 * 使用 PATH 命令或 Toolbox script。
 */
function jetBrains(
  id: string, productName: string, cliName: string, winExe: string, macNames: readonly string[],
): OpenInAppApp {
  return {
    id,
    platforms: {
      darwin: macApp(...macNames),
      win32: spec(
        {
          kind: 'scan',
          root: '${ProgramFiles}/JetBrains',
          namePrefix: productName,
          relativeLauncher: `bin/${winExe}`,
          args: [],
        },
        installRecord(productName, `bin/${winExe}`),
      ),
      linux: spec(cli(cliName), file([`~/.local/share/JetBrains/Toolbox/scripts/${cliName}`])),
    },
  }
}

/**
 * 按菜单顺序排列的启动 catalog：文件管理器、编辑器与 IDE、Git GUI、终端。
 * Finder、Terminal、Explorer 随各自 OS 提供，因此对应 locator 始终可解析。
 * macOS 列出常见 bundle 拼写；改名或移出已知应用根的 bundle 不会被检测。
 */
export const OPEN_IN_APP_CATALOG: readonly OpenInAppApp[] = [
  {
    id: 'finder',
    platforms: {
      darwin: spec({
        kind: 'fixed',
        launch: { kind: 'shell-open' },
        iconPath: '/System/Library/CoreServices/Finder.app',
      }),
    },
  },
  {
    id: 'explorer',
    platforms: {
      win32: spec({
        kind: 'fixed',
        launch: { kind: 'shell-open' },
        iconPath: '${SystemRoot}/explorer.exe',
      }),
    },
  },
  { id: 'filemanager', platforms: { linux: spec(desktopCli('xdg-open')) } },
  {
    id: 'cursor',
    platforms: {
      darwin: macApp('Cursor.app'),
      win32: spec(
        appPaths('Cursor.exe'),
        installRecord('Cursor'),
        file(['${LOCALAPPDATA}/Programs/cursor/Cursor.exe']),
      ),
      linux: spec(cli('cursor')),
    },
  },
  {
    id: 'vscode',
    platforms: {
      darwin: macApp('Visual Studio Code.app'),
      win32: spec(
        appPaths('Code.exe'),
        installRecord('Microsoft Visual Studio Code', 'Code.exe'),
        file([
          '${LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe',
          '${ProgramFiles}/Microsoft VS Code/Code.exe',
        ]),
      ),
      linux: desktopSpec('code', cli('code')),
    },
  },
  {
    id: 'vscodeinsiders',
    platforms: {
      darwin: macApp('Visual Studio Code - Insiders.app'),
      win32: spec(
        appPaths('Code - Insiders.exe'),
        installRecord('Microsoft Visual Studio Code Insiders', 'Code - Insiders.exe'),
        file(['${LOCALAPPDATA}/Programs/Microsoft VS Code Insiders/Code - Insiders.exe']),
      ),
      linux: desktopSpec('code-insiders', cli('code-insiders')),
    },
  },
  {
    id: 'windsurf',
    platforms: {
      darwin: macApp('Windsurf.app'),
      win32: spec(
        appPaths('Windsurf.exe'),
        installRecord('Windsurf'),
        file(['${LOCALAPPDATA}/Programs/Windsurf/Windsurf.exe']),
      ),
      linux: spec(cli('windsurf')),
    },
  },
  {
    id: 'zed',
    platforms: {
      darwin: macApp('Zed.app', 'Zed Preview.app'),
      linux: desktopSpec('dev.zed.Zed', cli('zed'), { kind: 'desktop', desktopId: 'dev.zed.Zed', args: [] }),
    },
  },
  {
    id: 'sublimetext',
    platforms: {
      darwin: macApp('Sublime Text.app'),
      win32: spec(
        appPaths('sublime_text.exe'),
        installRecord('Sublime Text'),
        file(['${ProgramFiles}/Sublime Text/sublime_text.exe']),
      ),
      linux: desktopSpec('sublime_text', cli('subl')),
    },
  },
  { id: 'xcode', platforms: { darwin: spec({ kind: 'xcode' }) } },
  {
    id: 'androidstudio',
    platforms: {
      darwin: macApp('Android Studio.app'),
      win32: spec(
        installRecord('Android Studio', 'bin/studio64.exe'),
        file(['${ProgramFiles}/Android/Android Studio/bin/studio64.exe']),
      ),
      linux: spec(cli('studio'), file([
        '~/.local/share/JetBrains/Toolbox/scripts/studio',
        '/opt/android-studio/bin/studio.sh',
      ])),
    },
  },
  jetBrains('intellij', 'IntelliJ IDEA', 'idea', 'idea64.exe',
    ['IntelliJ IDEA.app', 'IntelliJ IDEA Ultimate.app', 'IntelliJ IDEA CE.app']),
  jetBrains('pycharm', 'PyCharm', 'pycharm', 'pycharm64.exe',
    ['PyCharm.app', 'PyCharm Professional.app', 'PyCharm CE.app', 'PyCharm Community.app']),
  jetBrains('webstorm', 'WebStorm', 'webstorm', 'webstorm64.exe', ['WebStorm.app']),
  jetBrains('phpstorm', 'PhpStorm', 'phpstorm', 'phpstorm64.exe', ['PhpStorm.app']),
  jetBrains('goland', 'GoLand', 'goland', 'goland64.exe', ['GoLand.app']),
  jetBrains('rider', 'Rider', 'rider', 'rider64.exe', ['Rider.app', 'JetBrains Rider.app']),
  jetBrains('rustrover', 'RustRover', 'rustrover', 'rustrover64.exe', ['RustRover.app']),
  {
    id: 'fork',
    platforms: {
      darwin: macApp('Fork.app'),
      win32: spec(installRecord('Fork'), file(['${LOCALAPPDATA}/Fork/Fork.exe'])),
    },
  },
  { id: 'sourcetree', platforms: { darwin: macApp('Sourcetree.app') } },
  {
    id: 'github',
    platforms: {
      darwin: macApp('GitHub Desktop.app'),
      win32: spec({ kind: 'github-desktop', root: '${LOCALAPPDATA}/GitHubDesktop' }),
    },
  },
  { id: 'tower', platforms: { darwin: macApp('Tower.app') } },
  { id: 'gitkraken', platforms: { darwin: macApp('GitKraken.app') } },
  { id: 'smartgit', platforms: { darwin: macApp('SmartGit.app') } },
  {
    id: 'sublimemerge',
    platforms: {
      darwin: macApp('Sublime Merge.app'),
      win32: spec(
        appPaths('sublime_merge.exe'),
        installRecord('Sublime Merge'),
        file(['${ProgramFiles}/Sublime Merge/sublime_merge.exe']),
      ),
      linux: desktopSpec('sublime_merge', cli('smerge')),
    },
  },
  {
    id: 'ghostty',
    platforms: {
      darwin: macApp('Ghostty.app'),
      linux: desktopSpec(
        'com.mitchellh.ghostty',
        cli('ghostty', `--working-directory=${PATH_TOKEN}`),
        { kind: 'desktop', desktopId: 'com.mitchellh.ghostty', args: [`--working-directory=${PATH_TOKEN}`] },
      ),
    },
  },
  { id: 'warp', platforms: { darwin: macApp('Warp.app') } },
  { id: 'iterm', platforms: { darwin: macApp('iTerm.app') } },
  {
    id: 'kitty',
    platforms: {
      darwin: macApp('kitty.app'),
      linux: desktopSpec(
        'kitty',
        cli('kitty', '--directory'),
        { kind: 'desktop', desktopId: 'kitty', args: ['--directory'] },
      ),
    },
  },
  {
    id: 'terminal',
    platforms: {
      darwin: spec({
        kind: 'fixed',
        launch: { kind: 'argv', command: 'open', args: ['-a', 'Terminal'] },
        iconPath: '/System/Applications/Utilities/Terminal.app',
      }),
    },
  },
  { id: 'windowsterminal', platforms: { win32: spec(cli('wt', '-d')) } },
  {
    id: 'gitbash',
    platforms: {
      win32: spec(
        // Git for Windows 注册为 "Git version <x.y.z>"；裸 "Git" 前缀会误匹配 GitHub Desktop。
        installRecord('Git version', 'git-bash.exe', `--cd=${PATH_TOKEN}`),
        file(['${ProgramFiles}/Git/git-bash.exe'], `--cd=${PATH_TOKEN}`),
      ),
    },
  },
  {
    id: 'gnometerminal',
    platforms: {
      linux: desktopSpec(
        'org.gnome.Terminal',
        cli('gnome-terminal', `--working-directory=${PATH_TOKEN}`),
        { kind: 'desktop', desktopId: 'org.gnome.Terminal', args: [`--working-directory=${PATH_TOKEN}`] },
      ),
    },
  },
  {
    id: 'konsole',
    platforms: {
      linux: desktopSpec(
        'org.kde.konsole',
        cli('konsole', '--workdir'),
        { kind: 'desktop', desktopId: 'org.kde.konsole', args: ['--workdir'] },
      ),
    },
  },
]
