import { field, logger } from "@coder/logger"
import * as nbin from "@coder/nbin"
import * as fs from "fs-extra"
import * as glob from "glob"
import fetch from "node-fetch"
import * as os from "os"
import * as path from "path"
import { writeString } from "../common/buffer"
import { WritableFilesystem } from "../common/filesystem"
import { createFooter } from "../common/footer"
import * as ora from "ora"

export class Binary implements nbin.Binary {
  private readonly fs: WritableFilesystem = new WritableFilesystem()

  public constructor(private readonly options: nbin.BinaryOptions) {}

  public writeFile(pathName: string, content: Buffer): void {
    const parts = path
      .normalize(pathName)
      .split(path.sep)
      .filter((i) => i.length)
    let writableFs: WritableFilesystem = this.fs
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (i === parts.length - 1) {
        writableFs.write(part, content)
      } else {
        writableFs = writableFs.cd(part)
      }
    }
  }

  public writeFiles(globName: string, callback?: (fileWritten: string) => void): number {
    const files = glob.sync(globName, { cwd: process.cwd() })
    let fileCount = 0
    let spinner: ora.Ora | undefined
    if (this.canLog) {
      spinner = ora("Writing...")
    }
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const stat = fs.statSync(file)
      if (!stat.isFile()) {
        continue
      }
      this.writeFile(file, fs.readFileSync(file))
      if (spinner) {
        spinner.text = `Wrote "${file}"!`
      }
      if (callback) {
        callback(file)
      }
      fileCount++
    }
    if (spinner) {
      spinner.succeed(`Wrote ${fileCount} ${fileCount === 1 ? "file" : "files"}!`)
    }
    return fileCount
  }

  public writeModule(modulePath: string): void {
    if (!fs.existsSync(modulePath)) {
      throw new Error(`"${modulePath}" does not exist`)
    }
    const paths = glob.sync(path.join(modulePath, "**"))
    const moduleName = path.basename(modulePath)

    for (let i = 0; i < paths.length; i++) {
      const p = paths[i]
      const newPath = path.join("/node_modules", moduleName, path.relative(modulePath, p))
      const stat = fs.statSync(p)
      if (!stat.isFile()) {
        continue
      }
      this.writeFile(newPath, fs.readFileSync(p))
    }
    if (this.canLog) {
      logger.info("Packaged module", field("module", moduleName))
    }
  }

  public async build(): Promise<Buffer> {
    const nodeBuffer = await this.cacheBinary()

    // Create a buffer containing a (most likely) unique ID and its length.
    const version = this.version
    const versionBuffer = Buffer.alloc(2 + Buffer.byteLength(version))
    writeString(versionBuffer, version)

    // Writing the entrypoint
    const mainFileBuffer = Buffer.alloc(2 + Buffer.byteLength(this.options.mainFile))
    writeString(mainFileBuffer, this.options.mainFile)

    if (this.canLog) {
      logger.info("Building filesystem")
    }
    // Filesystem contents
    const fsBuffer = this.fs.build()

    // Footer
    const footerBuffer = createFooter(
      fsBuffer.header.byteLength + versionBuffer.byteLength + mainFileBuffer.byteLength, // Header byte length
      nodeBuffer.byteLength, // Header byte offset
      fsBuffer.fileContents.byteLength, // File contents length
      nodeBuffer.byteLength + fsBuffer.header.byteLength + versionBuffer.byteLength + mainFileBuffer.byteLength // File contents offset
    )

    return Buffer.concat([
      nodeBuffer,
      versionBuffer,
      mainFileBuffer,
      fsBuffer.header,
      fsBuffer.fileContents,
      footerBuffer,
    ])
  }

  private getXdgCacheHome(name: string): string {
    switch (process.platform) {
      case "win32":
        return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), "AppData/Local"), `${name}/Cache`)
      case "darwin":
        return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), "Library/Caches"), name)
      default:
        return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), name)
    }
  }

  private async cacheBinary(): Promise<Buffer> {
    let nodeBinaryPath = this.options.nodePath || path.join(__dirname, "../../lib/node/out/Release/node")
    const nodeBinaryName = this.nodeBinaryName

    // By default we use the locally compiled node. If that or the provided Node
    // path doesn't exist then we use the cache directory and will download a
    // pre-built binary there.
    if (!(await fs.pathExists(nodeBinaryPath))) {
      const cacheDir = this.getXdgCacheHome("nbin")
      nodeBinaryPath = path.join(cacheDir, nodeBinaryName)
    }

    // See if we already have the binary.
    if (await fs.pathExists(nodeBinaryPath)) {
      if (this.canLog) {
        logger.info("Returning cached binary", field("binary-name", nodeBinaryName))
      }
      return fs.readFile(nodeBinaryPath)
    }

    // The binary we need doesn't exist, fetch it.
    const binary = await this.fetchNodeBinary()
    await fs.mkdirp(path.dirname(nodeBinaryPath))
    await fs.writeFile(nodeBinaryPath, binary)

    if (this.canLog) {
      logger.info("Wrote and cached binary", field("binary-name", nodeBinaryName), field("path", nodeBinaryPath))
    }

    return binary
  }

  private async fetchNodeBinary(): Promise<Buffer> {
    const binName = this.nodeBinaryName
    const url = `https://nbin.cdr.sh/${binName}`
    if (this.canLog) {
      logger.info("Fetching", field("url", url))
    }

    const resp = await fetch(url)
    if (resp.status !== 200) {
      throw new Error(resp.statusText)
    }
    const buffer = await resp.arrayBuffer()

    return Buffer.from(buffer)
  }

  private get nodeBinaryName(): string {
    const currentPlatform = this.options.target || os.platform()
    let currentArchitecture = os.arch()
    if (currentArchitecture === "x64") {
      currentArchitecture = "x86_64"
    }
    const nodeVersion = "12.13.1"
    const binName = `${this.version}/node-${nodeVersion}-${currentPlatform}-${currentArchitecture}`

    return binName
  }

  private get canLog(): boolean {
    return !this.options.suppressOutput
  }

  private get version(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(path.resolve(__dirname, "../../package.json")).version
  }
}
