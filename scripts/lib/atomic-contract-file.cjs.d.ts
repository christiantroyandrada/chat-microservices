declare function replaceContractFile(
  targetPath: string,
  renderedBytes: string | Buffer,
  options?: { fs?: typeof import('node:fs') },
): void

export { replaceContractFile }
