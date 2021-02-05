import * as path from 'path';
import { spawn, StdioOptions } from 'child_process';
import * as through from 'through';
import * as stream from 'stream';

import * as log from './logging';
import * as cliArgs from './cli-args';

export default function runInParallell(
  programs: { program: string; args: string[]; prefix?: string }[],
  isGarn: boolean = true,
) {
  let anyStreamIsOutputting = false;
  let unpauseStreams: Array<() => void> = [];
  return Promise.all(
    programs.map(program => {
      return new Promise<void>(async (resolve, reject) => {
        let thisStreamIsOutputting = false;
        const stdio: StdioOptions = [process.stdin, 'pipe', 'pipe'];
        const args = program.args;
        if (isGarn) {
          for (const [name, value] of await cliArgs.getChildArgs()) {
            if (args.indexOf(name) === -1) {
              args.push(name);
              if (value !== undefined) {
                args.push(value);
              }
            }
          }
        }

        log.verbose(`Spawning '${program.program}${args.length === 0 ? '' : ' '}${args.join(' ')}'`);
        const command = spawn(program.program, args, { stdio });

        const outThrough = through(
          function (this: any, data) {
            this.queue((program.prefix || '') + data);
          },
          function (this: any) {
            this.queue(null);
          },
        );

        const errThrough = through(
          function (this: any, data) {
            this.queue((program.prefix || '') + data);
          },
          function (this: any) {
            this.queue(null);
          },
        );

        const outStream = new stream.Writable();
        (outStream as any)._write = (chunk: any, enc: any, next: () => void) => {
          outThrough.write(chunk);
          next();
        };
        const errStream = new stream.Writable();
        (errStream as any)._write = (chunk: any, enc: any, next: () => void) => {
          errThrough.write(chunk);
          next();
        };

        if (anyStreamIsOutputting) {
          outThrough.pause();
          errThrough.pause();
          unpauseStreams.push(() => {
            outThrough.resume();
            errThrough.resume();
            thisStreamIsOutputting = true;
          });
        } else {
          anyStreamIsOutputting = true;
          thisStreamIsOutputting = true;
        }

        command.stdout!.pipe(outStream);
        command.stderr!.pipe(errStream);

        outThrough.pipe(process.stdout);
        errThrough.pipe(process.stderr);

        command.on('exit', (code: number) => {
          if (code) {
            let programName = program.program;
            if (path.isAbsolute(programName)) {
              programName = path.basename(programName);
            }

            reject(`${programName} ${program.args.join(' ')} failed`);
          } else {
            resolve();
          }

          if (thisStreamIsOutputting) {
            const unpauseNext = unpauseStreams.shift();
            if (unpauseNext) {
              unpauseNext();
            }
          }
        });
      });
    }),
  ).then(
    () => {
      unpauseStreams.forEach(unpause => unpause());
      unpauseStreams = [];
    },
    e => {
      unpauseStreams.forEach(unpause => unpause());
      unpauseStreams = [];
      return Promise.reject(e);
    },
  );
}