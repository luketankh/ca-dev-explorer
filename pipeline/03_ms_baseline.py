"""Download Microsoft US Building Footprints v2 for California and keep the AOI.

This older Microsoft release is a "before" snapshot: a current Overture building that does not
overlap any footprint in it is treated as built after that snapshot.
"""
import zipfile

import duckdb

from common import AOI_BBOX, RAW, session

URL = "https://minedbuildings.z5.web.core.windows.net/legacy/usbuildings-v2/California.geojson.zip"
zpath = RAW / "ms_v2_California.geojson.zip"
out = RAW / "ms_v2_buildings.parquet"

if not zpath.exists():
    print(f"Downloading {URL} (~466 MB) ...")
    with session.get(URL, stream=True, timeout=600) as r:
        r.raise_for_status()
        tmp = zpath.with_suffix(".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
        tmp.rename(zpath)

with zipfile.ZipFile(zpath) as z:
    name = [n for n in z.namelist() if n.endswith(".geojson")][0]
    gj = RAW / name
    if not gj.exists():
        print(f"Extracting {name} ...")
        z.extract(name, RAW)

xmin, ymin, xmax, ymax = AOI_BBOX
con = duckdb.connect()
con.sql("INSTALL spatial; LOAD spatial;")
print("Filtering to AOI ...")
con.sql(f"""
COPY (
  SELECT * EXCLUDE (geom), geom AS geometry FROM ST_Read('{gj}')
  WHERE ST_Intersects(geom, ST_MakeEnvelope({xmin}, {ymin}, {xmax}, {ymax}))
) TO '{out}' (FORMAT PARQUET);
""")
n = con.execute(f"SELECT count(*) FROM '{out}'").fetchall()[0][0]
print(f"  wrote {out.name}: {n:,} footprints")
gj.unlink()  # the statewide GeoJSON is several GB; keep only the zip
