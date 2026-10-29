"""Build and deploy Qwen3.5-4B separately from the existing 9B application."""
import argparse

from build_qwen35_bundle import main as build_bundle
from deploy_qwen35 import connect, dependencies, runtime, models
from prepare_qwen35_4b import DEST, FILES, REPO, REVISION, ROOT

BUNDLE = ROOT / 'deployment/qwen35-4b'
SOURCE_REV = 'df7a244d43de018d6f2eec11cab6b6967039eacd'


def build():
    build_bundle(bundle=BUNDLE, destination=DEST, source_revision=SOURCE_REV,
                 source_repository='Qengineering/Qwen3.5-4B-NPU',
                 model_stem='qwen3.5-4b', lock_name='qwen35-4b')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', choices=['dependencies', 'runtime', 'models', 'all'], default='all')
    args = parser.parse_args()
    client, cfg, password = connect()
    remote = cfg['project_dir'].rstrip('/') + '/qwen35-4b'
    try:
        if args.stage in ('dependencies', 'all'):
            dependencies(client, password)
        if args.stage in ('runtime', 'all'):
            runtime(client, remote, bundle=BUNDLE, builder=build)
        if args.stage in ('models', 'all'):
            models(client, remote, destination=DEST, files=FILES, repository=REPO, revision=REVISION)
    finally:
        client.close()


if __name__ == '__main__':
    main()
