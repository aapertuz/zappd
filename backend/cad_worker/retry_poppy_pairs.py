import argparse
import json
import multiprocessing
from pathlib import Path
from queue import Empty

from poppy_interference import _worker, load_cached_report


def main():
    parser = argparse.ArgumentParser(description='Retry unresolved pinned Poppy pairs without rechecking resolved pairs')
    parser.add_argument('output', type=Path)
    parser.add_argument('--timeout', type=float, default=180)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('timeout must be positive')
    from poppy_catalog import POPPY_SPEC_PATH

    root = Path(__file__).parents[1]
    cache = root / 'data' / 'open_step_cache'
    spec = json.loads(POPPY_SPEC_PATH.read_text())
    report = load_cached_report(spec, cache)
    if report is None:
        raise ValueError('Catalog or fixtures differ from captured report')
    nodes = {node['id']: node for node in spec['nodes']}
    context = multiprocessing.get_context('spawn')
    retries = []
    for pair in report['pairs']:
        if pair['status'] not in ('failed', 'timeout'):
            continue
        queue = context.Queue()
        process = context.Process(target=_worker, args=(queue, [nodes[key] for key in pair['componentIds']], cache, report['volumeThresholdMm3']))
        process.start()
        try:
            result = queue.get(timeout=args.timeout)
        except Empty:
            result = dict(pair, error='Retry produced no result within deadline')
        finally:
            if process.is_alive():
                process.terminate()
            process.join()
            queue.close()
        retries.append(dict(original=pair, result=result, timeoutSeconds=args.timeout))
        args.output.write_text(json.dumps(dict(catalogSha256=report['catalogSha256'], retries=retries), indent=2))


if __name__ == '__main__':
    main()
