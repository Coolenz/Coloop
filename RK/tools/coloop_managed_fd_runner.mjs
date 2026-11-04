/** CPU-only Linux syscall checks. Imports an immutable copy of the production core. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  symlink,
  link,
  truncate,
  unlink,
  utimes,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [corePath, basePath] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert.equal(typeof corePath, "string");
assert.equal(typeof basePath, "string");
const base = resolve(basePath),
  fixtures = join(base, "fixtures");
const { readLinuxSnapshot, checkedSnapshot, MAX_FILE_BYTES } = await import(
  pathToFileURL(corePath).href
);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const original = Buffer.from(
  "PUBLIC_FD_FIXTURE\nRK_FD_UNCHANGED_ABCDEFGHIJKLMNOPQRSTUVWXYZ\n",
);
const replacement = Buffer.from("PUBLIC_FD_REPLACEMENT_DIFFERENT_BYTES\n");
const results = [],
  fixtureHashes = [];
await mkdir(fixtures, { mode: 0o700 });

async function ownDescriptors() {
  const found = [];
  for (const id of await readdir("/proc/self/fd")) {
    try {
      const target = await readlink(`/proc/self/fd/${id}`);
      if (target === fixtures || target.startsWith(fixtures + "/"))
        found.push(id);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return found.sort();
}
async function put(path, bytes = original) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  fixtureHashes.push({
    file: path.slice(fixtures.length + 1),
    bytes: bytes.length,
    sha256: digest(bytes),
  });
}
async function make(id, setup = async () => ({}), expected = {}) {
  const folder = join(fixtures, id),
    root = join(folder, "root"),
    path = join(root, "src", "sample.py");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const config = await setup({ folder, root, path });
  const input = config.input ?? original;
  if (!config.skipDefault) await put(path, input);
  const selectedRoot = config.root ?? root,
    relative = config.relative ?? "src/sample.py";
  const counts = { scanOpenCount: 0, scanBytes: 0 };
  const before = await ownDescriptors();
  let bytes, errorCode, checked, checkedError;
  try {
    bytes = await readLinuxSnapshot(selectedRoot, relative, {
      ...(config.options ?? {}),
      onOpen: async () => {
        counts.scanOpenCount++;
        await config.onOpen?.();
      },
      onBytes: async (size) => {
        counts.scanBytes += size;
        await config.onBytes?.(size);
      },
    });
    if (config.checkText) {
      try {
        checked = checkedSnapshot(bytes);
      } catch (error) {
        checkedError = error.message;
      }
    }
  } catch (error) {
    errorCode = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message ?? "")
      ? error.message
      : (error.code ?? "UNCLASSIFIED_ERROR");
  }
  const after = await ownDescriptors(),
    errors = [];
  const returned = bytes !== undefined;
  if (returned !== (expected.returned ?? false))
    errors.push("UNEXPECTED_DESCRIPTOR_OUTCOME");
  if (returned && !bytes.equals(expected.bytes ?? input))
    errors.push("FROZEN_BYTES_MISMATCH");
  if (!returned && expected.codes && !expected.codes.includes(errorCode))
    errors.push("UNEXPECTED_ERROR_CODE");
  if (counts.scanOpenCount !== expected.opens)
    errors.push("UNEXPECTED_OPEN_COUNT");
  if (
    expected.scanBytes !== undefined &&
    counts.scanBytes !== expected.scanBytes
  )
    errors.push("UNEXPECTED_SCAN_BYTES");
  if (
    expected.maxScanBytes !== undefined &&
    counts.scanBytes > expected.maxScanBytes
  )
    errors.push("READ_BOUND_EXCEEDED");
  if (
    expected.minScanBytes !== undefined &&
    counts.scanBytes < expected.minScanBytes
  )
    errors.push("MUTATION_NOT_EXERCISED");
  if (
    config.checkText &&
    expected.checkedCode &&
    checkedError !== expected.checkedCode
  )
    errors.push("TEXT_GUARD_NOT_EXERCISED");
  if (config.checkText && expected.checked === true && !checked)
    errors.push("TEXT_SNAPSHOT_NOT_ACCEPTED");
  if (
    checked &&
    (checked.sha256 !== digest(bytes) ||
      checked.returnedSha256 !== digest(Buffer.from(checked.text)))
  )
    errors.push("TEXT_HASH_MISMATCH");
  if (config.mutated && config.mutated() !== true)
    errors.push("MUTATION_NOT_EXERCISED");
  if (before.length || after.length) errors.push("OWN_DESCRIPTOR_LEAK");
  results.push({
    id,
    passed: !errors.length,
    errors,
    descriptor_returned: returned,
    ...(errorCode ? { error_code: errorCode } : {}),
    ...counts,
    ...(returned
      ? { snapshot_bytes: bytes.length, snapshot_sha256: digest(bytes) }
      : {}),
    ...(config.checkText
      ? {
          text_snapshot_accepted: !!checked,
          ...(checkedError ? { text_error_code: checkedError } : {}),
          ...(checked
            ? {
                returned_bytes: checked.returnedBytes,
                returned_sha256: checked.returnedSha256,
                truncated: checked.truncated,
              }
            : {}),
        }
      : {}),
    fixture_facts: config.facts ?? {},
    mutation_applied: config.mutated?.() ?? false,
    instrumentation:
      config.instrumentation ??
      "real_default_fs; onOpen/onBytes only count or synchronize stated mutations",
    own_fixture_fd_before: before.length,
    own_fixture_fd_after: after.length,
  });
}

await make("regular-ascii", async () => ({ checkText: true }), {
  returned: true,
  opens: 1,
  scanBytes: original.length,
  checked: true,
});
const unicode = Buffer.from("公开合成文件\n中文路径与😀结束\n");
await make(
  "regular-unicode",
  async () => ({ input: unicode, checkText: true }),
  { returned: true, opens: 1, scanBytes: unicode.length, checked: true },
);
await make(
  "exact-maximum",
  async () => ({ input: Buffer.alloc(MAX_FILE_BYTES, 65), checkText: true }),
  { returned: true, opens: 1, scanBytes: MAX_FILE_BYTES, checked: true },
);
await make("empty", async () => ({ input: Buffer.alloc(0) }), {
  opens: 0,
  scanBytes: 0,
  codes: ["UNSUPPORTED_MANAGED_FILE"],
});
await make(
  "oversize",
  async () => ({ input: Buffer.alloc(MAX_FILE_BYTES + 1, 65) }),
  { opens: 0, scanBytes: 0, codes: ["UNSUPPORTED_MANAGED_FILE"] },
);
for (const outside of [false, true]) {
  await make(
    `leaf-symlink-${outside ? "outside" : "inside"}`,
    async ({ folder, root, path }) => {
      const target = join(outside ? folder : root, "destination.py");
      await put(target);
      await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
      await symlink(target, path);
      return {
        skipDefault: true,
        facts: {
          symbolic_link: (await lstat(path)).isSymbolicLink(),
          target_inside_enrolled_root: !outside,
        },
      };
    },
    { opens: 0, scanBytes: 0, codes: ["UNSUPPORTED_MANAGED_FILE"] },
  );
  await make(
    `directory-symlink-${outside ? "outside" : "inside"}`,
    async ({ folder, root }) => {
      const target = join(outside ? folder : root, "destination");
      await put(join(target, "sample.py"));
      await mkdir(join(root, "src"), { recursive: true, mode: 0o700 });
      await symlink(target, join(root, "src", "linked"));
      return {
        skipDefault: true,
        relative: "src/linked/sample.py",
        facts: {
          symbolic_link: (
            await lstat(join(root, "src", "linked"))
          ).isSymbolicLink(),
          target_inside_enrolled_root: !outside,
        },
      };
    },
    { opens: 0, scanBytes: 0, codes: ["ENOTDIR", "ELOOP"] },
  );
}
await make(
  "root-symlink",
  async ({ folder, root, path }) => {
    await put(path);
    const enrolled = join(folder, "enrolled");
    await symlink(root, enrolled);
    return {
      skipDefault: true,
      root: enrolled,
      facts: {
        root_is_symbolic_link: (await lstat(enrolled)).isSymbolicLink(),
      },
    };
  },
  { opens: 0, scanBytes: 0, codes: ["ENOTDIR", "ELOOP"] },
);
await make(
  "root-ancestor-symlink",
  async ({ folder, root, path }) => {
    await put(path);
    const ancestor = join(folder, "ancestor");
    await symlink(folder, ancestor);
    return {
      skipDefault: true,
      root: join(ancestor, "root"),
      facts: {
        root_ancestor_is_symbolic_link: (
          await lstat(ancestor)
        ).isSymbolicLink(),
      },
    };
  },
  { opens: 0, scanBytes: 0, codes: ["ENOTDIR", "ELOOP"] },
);
await make(
  "hardlink",
  async ({ folder, path }) => {
    const target = join(folder, "destination.py");
    await put(target);
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    await link(target, path);
    return {
      skipDefault: true,
      facts: { link_count: (await lstat(path)).nlink },
    };
  },
  { opens: 0, scanBytes: 0, codes: ["UNSUPPORTED_MANAGED_FILE"] },
);
await make(
  "directory-target",
  async ({ path }) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
    return {
      skipDefault: true,
      facts: { directory: (await lstat(path)).isDirectory() },
    };
  },
  { opens: 0, scanBytes: 0, codes: ["UNSUPPORTED_MANAGED_FILE"] },
);
await make(
  "fifo-target",
  async ({ path }) => {
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    execFileSync("/usr/bin/mkfifo", ["--", path]);
    return { skipDefault: true, facts: { fifo: (await lstat(path)).isFIFO() } };
  },
  { opens: 0, scanBytes: 0, codes: ["UNSUPPORTED_MANAGED_FILE"] },
);
for (const mode of ["regular", "symlink"]) {
  await make(
    `path-replaced-after-open-${mode}`,
    async ({ folder, path }) => {
      let mutated = false;
      return {
        onOpen: async () => {
          await rename(path, path + ".held");
          if (mode === "regular") await put(path, replacement);
          else {
            const target = join(folder, "replacement.py");
            await put(target, replacement);
            await symlink(target, path);
          }
          mutated = true;
        },
        mutated: () => mutated,
      };
    },
    { returned: true, opens: 1, scanBytes: original.length, bytes: original },
  );
}
await make(
  "unlinked-after-open",
  async ({ path }) => {
    let mutated = false;
    return {
      onOpen: async () => {
        await unlink(path);
        await put(path, replacement);
        mutated = true;
      },
      mutated: () => mutated,
    };
  },
  { opens: 1, scanBytes: 0, codes: ["UNSUPPORTED_MANAGED_FILE"] },
);
await make(
  "root-replaced-after-file-open",
  async ({ root }) => {
    let mutated = false;
    return {
      onOpen: async () => {
        await rename(root, root + ".held");
        await put(join(root, "src", "sample.py"), replacement);
        mutated = true;
      },
      mutated: () => mutated,
    };
  },
  { returned: true, opens: 1, scanBytes: original.length, bytes: original },
);
for (const mode of ["truncate", "append", "overwrite", "grow-past-limit"]) {
  await make(
    `changed-after-bytes-${mode}`,
    async ({ path }) => {
      let mutated = false;
      return {
        onBytes: async () => {
          if (mutated) return;
          mutated = true;
          if (mode === "truncate") await truncate(path, 0);
          else if (mode === "append") await appendFile(path, replacement);
          else if (mode === "overwrite") {
            await writeFile(path, Buffer.alloc(original.length, 66));
            await utimes(path, 1, 1);
          } else await appendFile(path, Buffer.alloc(MAX_FILE_BYTES + 1, 67));
        },
        mutated: () => mutated,
      };
    },
    {
      opens: 1,
      minScanBytes: original.length,
      maxScanBytes: MAX_FILE_BYTES + 1,
      codes: ["MANAGED_FILE_CHANGED"],
    },
  );
}
for (const [id, input, code] of [
  ["binary-nul", Buffer.from([65, 0, 66]), "UNSUPPORTED_MANAGED_FILE"],
  ["invalid-utf8", Buffer.from([0xc3, 0x28]), "MANAGED_UTF8_REQUIRED"],
  ["text-control", Buffer.from([65, 0x1b, 66]), "MANAGED_TEXT_REQUIRED"],
])
  await make(id, async () => ({ input, checkText: true }), {
    returned: true,
    opens: 1,
    scanBytes: input.length,
    checkedCode: code,
  });

await make(
  "root-directory-pinned-before-file-open",
  async ({ root }) => {
    let mutated = false;
    return {
      options: {
        openFile: async (path, flags) => {
          const handle = await open(path, flags);
          try {
            if (
              !mutated &&
              path.endsWith("/root") &&
              flags & constants.O_DIRECTORY
            ) {
              await rename(root, root + ".held");
              await put(join(root, "src", "sample.py"), replacement);
              mutated = true;
            }
            return handle;
          } catch (error) {
            await handle.close();
            throw error;
          }
        },
      },
      mutated: () => mutated,
      instrumentation:
        "controlled interposition around real open syscall; real handle/flags retained; directory replaced after pin",
    };
  },
  { returned: true, opens: 1, scanBytes: original.length, bytes: original },
);
await make(
  "regular-replaced-between-lstat-and-open",
  async ({ path }) => {
    let mutated = false;
    return {
      options: {
        lstatFile: async (target) => {
          const actual = await lstat(target);
          if (!mutated && target.endsWith("/sample.py")) {
            await rename(path, path + ".held");
            await put(path, replacement);
            mutated = true;
          }
          return actual;
        },
      },
      mutated: () => mutated,
      instrumentation:
        "controlled interposition after real lstat and before real open; real captured stat/handle/flags retained",
    };
  },
  { opens: 1, scanBytes: 0, codes: ["UNSUPPORTED_MANAGED_FILE"] },
);

const openFixtureDescriptors = await ownDescriptors();
console.log(
  JSON.stringify(
    {
      passed:
        results.every((row) => row.passed) && !openFixtureDescriptors.length,
      platform: process.platform,
      runtime: { name: "Bun", version: process.versions.bun },
      source_core_sha256: digest(
        await (await import("node:fs/promises")).readFile(corePath),
      ),
      cases: results.length,
      passed_cases: results.filter((row) => row.passed).length,
      no_agent_started: true,
      npu_calls: 0,
      network_requests: 0,
      permit_issued: false,
      raw_fixture_text_exported: false,
      own_fixture_fd_remaining: openFixtureDescriptors.length,
      kernel_checks_are_controlled_not_uncontrolled_race_proof: true,
      results,
      fixture_hashes: fixtureHashes,
    },
    null,
    2,
  ),
);
process.exitCode =
  results.every((row) => row.passed) && !openFixtureDescriptors.length ? 0 : 1;
