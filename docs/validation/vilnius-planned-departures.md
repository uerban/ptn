# Vilnius planned departure evidence

Source is the JUDU GTFS snapshot acquired on 2026-11-16 from [stops.lt](https://www.stops.lt/vilnius/vilnius/gtfs.zip). The archive SHA-256 is `cb0f07c01e86c68256b12338a1bc73f7935b635301777894c1aeb2767b71df88`. Times are local to Vilnius. The services below are active on Friday, 2026-11-20 in the retained snapshot.

## Planned line 22 leg

Trip `A22-02-1-260901-ba-1520` (service `507514`) departs Juozo Tumo-Vaižganto st. (`5264`, sequence 2) at 15:21 and arrives at Mikalojaus Konstantino Čiurlionio st. (`683`, sequence 3) at 15:24. Its headsign is **Lazdynai**. The expected boarding label is **22 toward Lazdynai · 15:21**.

## Line 123 branch near Vaduvos st.

Both trips are line **123** (`vilnius_bus_123`), direction `1`, service `512515`. Both allow boarding at Vilkpėdės st. (`5543`, sequence 9).

| Departure | Headsign | Trip ID | Downstream service |
| --- | --- | --- | --- |
| 06:09 | Žemieji Paneriai (Vaduvos g.) | `A123-01-1-261010-ba-0600` | Vaduvos st. (`5567`, sequence 14) at 06:17, with drop-off allowed |
| 06:28 | Riovonys | `A123-03-1-261010-bc-0620` | Skips Vaduvos st. |

Use this pair to test a rider boarding at Vilkpėdės st. for Vaduvos st. The correct trip is the 06:09 toward Žemieji Paneriai (Vaduvos g.). The 06:28 toward Riovonys is a different branch.
