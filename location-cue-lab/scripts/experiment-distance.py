import json, sys
from pyproj import Geod
payload=json.load(sys.stdin)
g=Geod(ellps='WGS84')
_,_,distance=g.inv(payload['predicted']['longitude'],payload['predicted']['latitude'],payload['truth']['longitude'],payload['truth']['latitude'])
print(json.dumps({'distanceM':distance,'metric':'pyproj.Geod(WGS84).inv'}))
