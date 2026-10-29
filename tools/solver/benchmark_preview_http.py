"""Measured local HTTP roundtrips to a temporary, closed-on-exit preview server."""
import argparse
import json
from pathlib import Path
import threading
import time
import urllib.request
from practical_preview_server import make_server


def benchmark(cases, model):
    # Outcome-independent selection: first six public prefixes per street.
    chosen = []
    for street in ('flop','turn','river'):
        chosen += [(key,value) for key,value in cases.items() if value['request']['street']==street][:6]
    server = make_server(model=model)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    rows = []
    try:
        url = 'http://127.0.0.1:' + str(server.server_port) + '/preview'
        for index, (key, value) in enumerate(chosen):
            data = json.dumps(dict(decisionId=f'http-{index}', request=value['request'])).encode()
            req = urllib.request.Request(url, data=data, headers={'Content-Type':'application/json'})
            start = time.perf_counter()
            with urllib.request.urlopen(req, timeout=5) as response:
                result = json.load(response)
            elapsed = (time.perf_counter()-start)*1000
            rows.append(dict(caseId=key, clientRoundtripMs=elapsed, response=result))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)
    return dict(scope='Local HTTP + worker startup + ranges + equity + Node; excludes collector/game/bridge',
                mode='isolated_preview', rows=rows, requests=len(rows),
                successes=sum(r['response']['status']=='ok' for r in rows),
                maxClientRoundtripMs=max(r['clientRoundtripMs'] for r in rows),
                publishable=False)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--cases', type=Path, required=True)
    ap.add_argument('--range-model', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()
    result = benchmark(json.loads(args.cases.read_text(encoding='utf-8')),str(args.range_model.resolve()))
    args.out.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k!='rows'}))
