import fs from 'node:fs';
import * as s from 'node:stream';
import cp from 'node:child_process';

export type TaggerOptions = { name: string; color: string };
export type CommandOptions = cp.SpawnOptionsWithoutStdio &
  TaggerOptions & { onExit?: (code?: number) => any; noTagger?: boolean };

export class Command {
  proc: cp.ChildProcessWithoutNullStreams | undefined;
  tagger: Tagger;

  constructor(public command: string, public args: string[], public options: CommandOptions) {
    this.tagger = new Tagger(options);
  }

  async run() {
    return new Promise((resolve, reject) => {
      this.proc = cp.spawn(this.command, this.args, this.options);

      this.proc.stdout.pipe(new LinePrefixTransform(this.tagger)).pipe(process.stdout);
      this.proc.stderr.pipe(new LinePrefixTransform(this.tagger)).pipe(process.stderr);

      this.proc.on('close', code => {
        console.error(`${this.tagger.get()} exited with code ${code}.`);
        if (this.options.onExit) {
          // console.error(`${this.tagger.get()} Killing other processes...`);
          // killAllAndExit(code ?? undefined);
          this.options.onExit(code ?? undefined);
        }
        if (code === 0) {
          resolve(0);
        } else {
          reject(new Error(`code ${code}`));
        }
      });
    });
  }
}

class LinePrefixTransform extends s.Transform {
  constructor(public tagger: Tagger) {
    super();
  }

  _transform(chunk: any, encoding: BufferEncoding, callback: s.TransformCallback) {
    const chunkStr: string = chunk.toString();
    this.push(
      chunkStr
        .split('\n')
        .map(line => `${this.tagger.get()} ${line}`)
        .join('\n'),
    );
    if (chunkStr.endsWith('\n')) this.push('\n');
    callback();
  }
  // _transform(chunk, encoding, callback) {
  //   const lines = chunk.toString().split('\n');
  //   for (const line of lines) {
  //     if (line.length > 0) {
  //       this.push(this.tagger.get());
  //       this.push(line);
  //     }
  //     this.push('\n');
  //   }
  //   callback();
  // }
}

export class Tagger {
  constructor(public options: TaggerOptions) {}

  get() {
    return `${COLORS[this.options.color]}[${this.options.name}]${COLORS.reset}`;
  }
}

export async function canAccessPath(p: string) {
  try {
    await fs.promises.access(p);
    return true;
  } catch (error) {
    return false;
  }
}

export function timeout(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitUntilFileAccessible(filePath: string) {
  while (!(await canAccessPath(filePath))) {
    await timeout(100);
  }
}

export const COLORS: { [key: string]: string } = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',
  fgBlack: '\x1b[30m',
  fgRed: '\x1b[31m',
  fgGreen: '\x1b[32m',
  fgYellow: '\x1b[33m',
  fgBlue: '\x1b[34m',
  fgMagenta: '\x1b[35m',
  fgCyan: '\x1b[36m',
  fgWhite: '\x1b[37m',
  fgGray: '\x1b[90m',
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
  bgGray: '\x1b[100m',
};
