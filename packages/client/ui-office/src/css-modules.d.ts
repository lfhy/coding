/** 功能包样式由客户端构建预设处理。 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css?inline' {
  const style: string
  export default style
}
