/** picomatch 的 POSIX 入口不附带声明；仅描述本包使用的 glob 编译能力。 */
declare module 'picomatch/posix' {
  interface Options {
    readonly nocase?: boolean
    readonly dot?: boolean
    readonly basename?: boolean
  }

  const picomatch: (pattern: string, options?: Options) => (address: string) => boolean
  export default picomatch
}
