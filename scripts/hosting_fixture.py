"""Private temporary feed variations for installation checks; no fixture bytes are committed."""
import csv
import io
import zipfile


def change_stop_label(source, target):
    # stop_name is a GTFS Text field. Keep every routing record unchanged.
    # https://gtfs.org/documentation/schedule/reference/#stopstxt
    changed = False
    with zipfile.ZipFile(source) as source_zip, zipfile.ZipFile(target, "w") as target_zip:
        for info in source_zip.infolist():
            payload = source_zip.read(info)
            if info.filename == "stops.txt":
                reader = csv.DictReader(io.StringIO(payload.decode("utf-8-sig")))
                rows = list(reader)
                rows[0]["stop_name"] += " (installation reload check)"
                text = io.StringIO()
                writer = csv.DictWriter(text, fieldnames=reader.fieldnames, lineterminator="\n")
                writer.writeheader()
                writer.writerows(rows)
                payload = text.getvalue().encode()
                changed = True
            target_zip.writestr(info, payload)
    if not changed:
        raise ValueError("test feed has no stops.txt")
