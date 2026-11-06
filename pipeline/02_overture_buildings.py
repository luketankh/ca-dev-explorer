"""Extract Overture Maps buildings for the AOI via DuckDB (reads GeoParquet straight from S3)."""
import duckdb

from common import AOI_BBOX, OVERTURE_RELEASE, RAW

out = RAW / "overture_buildings.parquet"
xmin, ymin, xmax, ymax = AOI_BBOX
src = (f"s3://overturemaps-us-west-2/release/{OVERTURE_RELEASE}"
       "/theme=buildings/type=building/*")

con = duckdb.connect()
con.sql("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
print(f"Querying Overture {OVERTURE_RELEASE} buildings in {AOI_BBOX} ...")
con.sql(f"""
COPY (
  SELECT
    id,
    class,
    subtype,
    height,
    num_floors,
    sources[1].dataset AS source_dataset,
    geometry
  FROM read_parquet('{src}', hive_partitioning=1)
  WHERE bbox.xmin >= {xmin} AND bbox.xmax <= {xmax}
    AND bbox.ymin >= {ymin} AND bbox.ymax <= {ymax}
) TO '{out}' (FORMAT PARQUET);
""")
n = con.execute(f"SELECT count(*) FROM '{out}'").fetchall()[0][0]
print(f"  wrote {out.name}: {n:,} buildings")
print(con.sql(f"SELECT source_dataset, count(*) n FROM '{out}' GROUP BY 1 ORDER BY 2 DESC"))
