"""Build a separate RKLLM 1.3.1 comparison app, reusing verified 4B model files."""
import hashlib
import json
import shlex
import shutil

from deploy_qwen35 import connect, runtime, command
from deploy_qwen35_4b import BUNDLE, ROOT


def main():
    destination = ROOT / 'deployment/qwen35-4b-131'
    shutil.copytree(BUNDLE, destination, dirs_exist_ok=True)
    sdk = ROOT / 'downloads/rkllm-1.3.1/rkllm-runtime/Linux/librkllm_api'
    for original, name in [(sdk / 'aarch64/librkllmrt.so', 'lib/librkllmrt.so'),
                           (sdk / 'include/rkllm.h', 'include/rkllm.h')]:
        shutil.copyfile(original, destination / name)
    run = destination / 'run.sh'
    run.write_text(run.read_text(encoding='utf-8').replace('.qwen35-4b-inference.lock',
                   '.qwen35-4b-131-inference.lock'), encoding='utf-8', newline='\n')
    manifest = json.loads((destination / 'source-manifest.json').read_text())
    manifest['runtime'] = '1.3.1'
    manifest['runtime_source'] = json.loads((ROOT / 'downloads/rkllm-1.3.1/source.json').read_text())
    manifest['files'] = {p.relative_to(destination).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                         for p in destination.rglob('*') if p.is_file() and p.name != 'source-manifest.json'}
    (destination / 'source-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    client, cfg, _ = connect()
    remote = cfg['project_dir'].rstrip('/') + '/qwen35-4b-131'
    try:
        runtime(client, remote, bundle=destination, builder=lambda: None)
        command(client, 'cd ' + shlex.quote(remote) + '''
test ! -e qwen3.5-4b_w8a8_rk3588.rkllm || test -L qwen3.5-4b_w8a8_rk3588.rkllm
test ! -e qwen3.5-4b_vision_rk3588.rknn || test -L qwen3.5-4b_vision_rk3588.rknn
ln -sfn ../qwen35-4b/qwen3.5-4b_w8a8_rk3588.rkllm .
ln -sfn ../qwen35-4b/qwen3.5-4b_vision_rk3588.rknn .
''')
    finally:
        client.close()


if __name__ == '__main__':
    main()
