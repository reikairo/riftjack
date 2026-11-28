import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run only in the standalone reader or Claude hook process. Pin the containing
// directory as cwd before checking its physical path, then open the basename
// relative to that directory. A renamed ancestor cannot redirect this open.
export function renderFiles(workspace, files, heading, reminder) {
  let remaining = 256 * 1024;
  const sections = [heading];
  for (const file of files) {
    let fd;
    try {
      const parent = dirname(join(workspace, file));
      process.chdir(parent);
      if (realpathSync.native('.') !== parent) throw Error();
      fd = openSync(basename(file), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > remaining) throw Error();
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length);
        if (!count) break;
        length += count;
      }
      if (BigInt(length) !== before.size || fstatSync(fd, { bigint: true }).ctimeNs !== before.ctimeNs) throw Error();
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
      if (content.includes('\0')) throw Error();
      sections.push('File ' + JSON.stringify(file) + '\n' + content);
      remaining -= length;
    } catch {
      return heading + '\nCould not include the complete file set while reading ' + JSON.stringify(file) + '.\n' + reminder;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return sections.join('\n\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [workspace, files, heading, reminder] = process.argv.slice(2);
  process.stdout.write(renderFiles(workspace, JSON.parse(files), heading, reminder));
}
