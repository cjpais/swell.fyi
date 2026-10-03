# Taiwan surf data: what exists, where it comes from, what to trust

Researched 2026-10-02. "Verified" means the endpoint was hit and a real response parsed during this research; anything else is labelled.

## Short version

- **The government buoy data is genuinely open, and you don't need a key to get it.** CWA (中央氣象署, Central Weather Administration) publishes about 28 wave-measuring buoys and about 55 tide/weather stations every hour. Its official API redirects to a public S3 bucket that anyone can read, and the files allow direct browser requests (CORS). *Verified.*
- **CWA already makes a surf forecast.** Dataset M-B0078-001 is a 72-hour, 3-hourly wave height/period/direction forecast for 170 points. 13 of them are named surf spots, including 蜜月灣, 港澳 (Wushi), 金樽, 港口 (Jialeshui), 南灣 and 中角. It comes from CWA's own WAVEWATCH III run. *Verified.*
- **The open forecasts have no swell partitions.** CWA's surf index, swell height and swell period live only on its login-gated ocean portal. For swell vs wind-sea you need global models: MFWAM and GFS-Wave via Open-Meteo, or raw GFS-Wave and Copernicus.
- **History is the bottleneck, and partly solved.** The open feed keeps only 48 hours (O-B0075-001) and 30 days (O-B0075-002). The JSON behind CWA's ocean portal gives about 2 years per buoy, matching the official values hour for hour; it's already pulled into `data/archive/`. Run the fetch script on a schedule to keep extending the archive; that archive is the training set for any future model.
- **No published study ranks the models at Taiwan's buoys,** so we scored them ourselves (§2). Over the last 92 days:
  - all three global models read high overall, by 20–60% at most buoys (less in the southeast);
  - from Chenggong south, all three are 20–34% low when it's big, matching the literature's typhoon underestimation;
  - MFWAM and ECMWF get the timing right more often than GFS.
  
  The buoy pages compute these scores live.

## 1. Observed data (truth)

### CWA marine observations: the backbone

| Dataset | What | Window | Access |
|---|---|---|---|
| **O-B0075-001** | Hourly obs, all marine stations | last 48 h | `https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Observation/O-B0075-001.zip` (no key), or REST with key |
| **O-B0075-002** | Same | last 30 days | `.../Observation/O-B0075-002.zip` (~42 MB, updated daily ~01:50) |
| **O-B0076-001** | Station metadata: ID, names, lat/lon, type, operator, status | current | `.../Observation/O-B0076-001.json` |
| O-B0070-001 | Long-period swell watch (長浪: period ≥ 8 s, height ≥ 1.5 m), last 8 h max | hourly | `.../Observation/O-B0070-001.json` (stations keyed by name) |

The ZIPs hold one XML per station (`46699A.xml` and so on). This repo's `scripts/fetch-cwa.ts` parses them.

**Fields** (verified): WaveHeight (m), WaveDirection (°, *from*), WavePeriod (s), SeaTemperature, Temperature, StationPressure, wind (speed, direction *from*, gust, Beaufort), TideHeight (m, TWVD2001), and surface current (speed, direction *toward*). `None` means the station doesn't measure it or sent no data; `-` means a comms or instrument fault.

**What "wave height" and "period" mean.** CWA doesn't document it. One matched sample against the NAMR NODASS feed for the same buoy and hour lined WaveHeight up with *significant* wave height, and WavePeriod with *mean* period, not peak. Treat period as Tm, not Tp. That's why the buoy's period reads shorter than a surf app's "swell period".

**Key east-coast stations** (verified from O-B0076-001):

| ID | Station | Operator | Lat, lon | Notes |
|---|---|---|---|---|
| 46694A | Longdong 龍洞 | CWA | 25.098, 121.922 | NE cape; Fulong / NE coast |
| OAC005 | Honeymoon Bay 蜜月灣 | NAMR (Ocean Affairs Council) | 24.949, 121.929 | right off the break; intermittent in CWA's feed |
| 46708A | Guishan Island 龜山島 | CWA | 24.847, 121.927 | Yilan / Wushi |
| 46706A | Su-ao 蘇澳 | WRA | 24.625, 121.876 | |
| 46699A | Hualien 花蓮 | CWA | 24.031, 121.633 | |
| 46761F | Chenggong 成功 | CWA | 23.133, 121.420 | wave-rider in 28 m water by Sanxiantai, the most "nearshore" buoy on the coast |
| WRA007 | Taitung 臺東 | WRA | 22.722, 121.140 | |
| C6S94 | Lanyu 蘭嶼 | CWA | 22.074, 121.582 | open-ocean, first to see typhoon swell from the SE |
| 46759A | Eluanbi 鵝鑾鼻 | WRA | 21.916, 120.811 | southern tip |
| NTU01/02 | NTU typhoon buoys | NTU | 21.2/123.9, 21.8/122.6 | far offshore SE; early warning for typhoon swell |

Elsewhere: Fugui Cape C6AH2 (north coast), Pengjiayu C6B01, Hsinchu 46757B, Taichung C6F01, Penghu 46735A, Qigu 46778A, Mituo COMC08, Xiao Liuqiu 46714D, Kinmen, Matsu, Pratas. Tide gauges at Wushi (C4U02), Su-ao, Hualien, Shiti (1566), Chenggong (C4S02) and others.

**API keys.** Registration at opendata.cwa.gov.tw is free. A key gives 20,000 calls/day and unlocks the REST datastore. The REST datastore filters by station, element and time (`/api/v1/rest/datastore/O-B0075-001?Authorization=KEY&StationID=46708A&WeatherElement=WaveHeight,WavePeriod`). The file API (`/fileapi/v1/opendataapi/{ID}?Authorization=KEY&format=ZIP`) is a 302 to the same S3 object, so the S3 route gets identical data without a key, just undocumented. **License:** Taiwan Open Government Data License 1.0 (CC BY 4.0 compatible); attribute 交通部中央氣象署.

### Longer history

- **ocean.cwa.gov.tw undocumented JSON** (wired up as `bun run backfill:history`). `POST https://ocean.cwa.gov.tw/V2/map_common/get_station_info` with `station_id`, `kind=buoy`, `end_time` (Taiwan local), `time_range=8760` and header `X-Requested-With: XMLHttpRequest`.
  - Each call returns one year of hourly wave height/period/direction, wind, SST and current.
  - *Verified:* timestamps are Taiwan time. Cross-correlation against MFWAM at Hualien peaks at 0–2 h lag (r ≈ 0.90).
  - Calls take 30–60 s and occasionally return a mostly-empty year that comes back full on retry.
  - *Verified provenance:* where portal history overlapped the official O-B0075 30-day data, wave height matched in **every** hour. That's about 20 buoys at 465–756 overlapping hours each, 100% agreement. So it's the same data, just more of it.
  - *Depth after running it on all 32 wave buoys:* most east and north coast buoys have dense hourly history from mid-2024 (Chenggong from mid-2025), with some multi-week gaps. That's about 137,000 hourly rows. Peaks in the archive include 9.5 m at Chenggong, 8.6 m at Lanyu, 8.1 m at Taitung and 7.0 m at Su-ao.
- **All-buoy snapshots.** `POST .../V2/main_menu_draw/get_api_buoy` (`time=YYYY-MM-DD HH:00:00`) returns every buoy for one hour, reportedly back to late 2019. *Not re-tested here.*
- **Status.** Both endpoints are unofficial and could break. They're still the best free route to a multi-year training set.
- **CWA data service.** Older raw buoy records (Hualien since 1997, Longdong since 1998) appear to need a formal application, possibly paid.
- **Copernicus Marine In Situ** has 14 CWA buoys, but only 2012–2017 and Hs/wind only.
- **Taiwan buoys are not on NOAA NDBC or the GTS.** International apps can't assimilate them.

### Other Taiwanese sources

- **NAMR NODASS** (`https://nodass.namr.gov.tw/noapi/namr/v1/obs/...`). Free JSON with Hs, *mean and peak period* and direction for NAMR, WRA and CWA buoys, including Honeymoon Bay since 2021. The open window is about 2.5 days; full history needs an account token. No CORS, so fetch server-side.
- **IHMT harbour wave gauges** (`https://isohe.ihmt.gov.tw/opendata/Wave?port=SA|HL&format=JSON`, 72 h; monthly CSVs since 2018). Seabed-mounted gauges at −26 m and −33 m outside Su-ao and Hualien harbours. They report peak period Tp, which is a useful complement.
- **GoOcean** (goocean.namr.gov.tw). A derived 1–10 surf index for NE-coast beaches; no API.

## 2. Forecasts

### CWA's own wave model

CWA runs WAVEWATCH III ("NWW3") four times a day on nested grids down to 0.025° (~2.5 km) around Taiwan. The outer grid uses GFS winds and the inner grids CWA's own WRF winds. There's no operational nearshore SWAN model. Published outputs:

| Dataset | What | Access |
|---|---|---|
| **M-B0078-001** | Point forecasts: Hs, period, 16-point direction, current. 3-hourly, 72 h, updated every ~6 h. 170 points: beaches (A), fishing spots (B), harbours (I), ports (H), snorkel sites (N), **surf spots (O001–O013)** | `.../Model/M-B0078-001.json`, verified |
| **F-A0020-001** | Gridded 0.1° Hs, period and direction, **hourly to 168 h** | `.../Forecast/F-A0020-001.zip` (58 MB zip → ~2.5 GB XML). Marked withdrawn on data.gov.tw but still updating; could disappear |
| F-A0021-001 | Tide high/low times and heights, 1 month, 266 locations | `.../Forecast/F-A0021-001.json`, verified |
| F-A0012-001 | Sea-area text forecasts (wave height as "1至2公尺") | `.../Forecast/F-A0012-001.json` |

The official surf page (cwa.gov.tw/V8/C/L/Surfing) uses the same 13 spot IDs. The richer surf index, swell height and swell period on ocean.cwa.gov.tw are not in any open dataset.

### Global models with free access

| Source | Resolution / horizon | Swell partitions | Access |
|---|---|---|---|
| **Open-Meteo Marine** | wraps the models below | MFWAM and GFS yes; ECMWF no | `marine-api.open-meteo.com/v1/marine`, no key, CORS. **Free tier is non-commercial.** Used by this site |
| Météo-France MFWAM | 1/12° (~9 km), ~10 days | primary, secondary, wind sea | Open-Meteo, or Copernicus Marine `cmems_mod_glo_wav_anfc_0.083deg_PT3H-i` (free login) |
| NOAA GFS-Wave (WW3) | 0.16°, hourly to 120 h then 3-hourly to 16 days | 3 swell partitions + wind sea | Open-Meteo, or NOMADS GRIB2 (`filter_gfswave.pl` subsetting works); public domain |
| ECMWF WAM | 0.25° open data (9 km native via Open-Meteo), 15 days | none, but open data includes **wave height in period bands** (10–12 s, 12–14 s … 25–30 s), the best free long-period-swell signal | `data.ecmwf.int/forecasts/.../wave/` GRIB2, CC BY 4.0 |
| ECMWF / GEFS wave ensembles | 51 / 31 members, 15–16 days | — | raw GRIB only; Open-Meteo's wave ensembles returned all nulls when tested |
| DWD GWAM | 0.25°, ~7 days | swell + wind sea | opendata.dwd.de or Open-Meteo |
| JMA global / coastal | 0.25° / 0.05°, 132 h / 72 h | — | Kyoto Univ. RISH mirror, research use only |

### Which is best for Taiwan?

**No published head-to-head exists.** What the literature does say:

- **Typhoon swell (east coast, summer–autumn).** Every coarse model underestimates the peak. ERA5-driven waves reached about half the observed peak at the Hualien and Taitung buoys in Typhoon Nepartak (Hsiao et al. 2020, *JMSE* 8:217). ECMWF does worse in typhoons than in cold surges (Wang et al. 2019, *Weather and Forecasting*). Treat model typhoon peaks as lower bounds, and watch Lanyu, NTU01/02 and Eluanbi for the swell arriving.
- **NE monsoon wind swell (Oct–Mar, north and east coast).** Models handle large-scale monsoon fetch much better. Resolution matters close to the coast, which favours CWA's 2.5 km grid and the 9 km MFWAM/ECMWF over 0.25° grids.
- **CWA's WW3 swell.** A 2022 NKUST thesis (unverified) found 48-hour swell correlation of 0.66–0.86, with swell height 21–33% low at Taitung and Guishan.
- **This site's buoy pages score the models for you.** Each wave buoy page matches MFWAM, GFS-Wave and ECMWF against the buoy hour by hour over up to 92 days. Open-Meteo's past values are stitched from its latest short-range runs, so this is roughly day-one skill.
- **92-day scorecard, east coast** (2026-07-02 to 10-02, which includes this summer's typhoons). Open-Meteo past values vs CWA buoys, about 2,100 matched hours each. Cells read: overall bias / correlation / bias when the buoy read Hs > 2 m.

  | Buoy | MFWAM | GFS-Wave | ECMWF |
  |---|---|---|---|
  | Longdong 46694A | +39% / **0.94** / +22% | +42% / 0.86 / +24% | +43% / 0.93 / +26% |
  | Guishan 46708A | +48% / 0.90 / +33% | +55% / 0.91 / +57% | +30% / **0.92** / +21% |
  | Su-ao 46706A | +42% / **0.93** / +17% | +29% / 0.86 / +2% | +34% / 0.92 / +13% |
  | Hualien 46699A | +35% / **0.81** / +3% | +26% / 0.67 / −9% | +61% / 0.80 / +22% |
  | Chenggong 46761F | +10% / **0.84** / −28% | +5% / 0.76 / −34% | +23% / 0.78 / −24% |
  | Taitung WRA007 | +8% / **0.84** / −27% | +3% / 0.77 / −26% | +19% / 0.76 / −26% |
  | Lanyu C6S94 (731 h) | +19% / 0.48 / −18% | +9% / 0.54 / −21% | +26% / **0.79** / −4% |
  | Eluanbi 46759A | +41% / 0.78 / +11% | +22% / 0.77 / −2% | +17% / **0.94** / +0% |

  What it says:
  - **Calm days:** every model overestimates small, everyday seas at almost every buoy, often by 30–60%.
  - **Big days, southeast:** from Chenggong south, all three are 20–34% *low* when it's actually big. That's the typhoon-underestimation problem showing up in live data.
  - **Timing:** MFWAM and ECMWF track the ups and downs better than GFS (higher correlation at 7 of 8 buoys).
  - **The raw-model gap is large and different at each buoy.** That's why a simple per-buoy correction is the obvious first model to build.
  - One season only; rerun once the archive spans a winter monsoon.
- **Period:** every model's mean period runs 1.5–3.5 s longer than the buoys'. One possible explanation (a guess, untested) is that CWA's buoy "period" is a zero-crossing mean (Tz), which reads shorter than a model's Tm. Either way, compare trends, not absolute values.
- **Why the models read high.** Part of it is the buoys themselves. Hualien sits about 0.3 km off Qixingtan in 24 m of water, and Guishan sits 0.8 km *west* of the island in 16 m, in its lee for east swell. Chenggong is a nearshore wave-rider in 28 m. These are closer to "at the beach" than the open-ocean cells a global model represents.

**Practical ranking to start with:**
1. CWA M-B0078 for the 3-day outlook at its spots (highest resolution, local winds).
2. MFWAM for swell partitions out to ~10 days.
3. GFS-Wave for 16-day range and a second opinion on partitions.
4. ECMWF as the total-sea cross-check.

Revisit once the archive has a season of data.

## 3. Where commercial apps get their data

- **Swelleye** (Taiwanese, 44 spots, 9-day forecast). Doesn't disclose its wave model. It says it uses CWA for typhoon info and NCDR GFS for wind. No API.
- **Surfline.** Proprietary LOTUS model with satellite and buoy assimilation plus nearshore bathymetry. Its WW3 base and Taiwan coverage aren't public. Since Taiwan's buoys aren't on the GTS, Surfline likely can't assimilate them.
- **Windy.** ECMWF-WAM (default), GFS-Wave, CMEMS and JMA layers. The point API's free tier returns randomized data.
- **Windguru**: GFS-Wave, ECMWF and Canada's GDWPS. **Surf-forecast.com**: NWW3.
- **Magicseaweed** shut down in 2023 (merged into Surfline).

In short, nearly every app is a global WW3/WAM model with some post-processing. None of them see CWA's buoys.

## 4. Data for building our own model later

| Dataset | Span | Why |
|---|---|---|
| **This repo's archive** (`data/archive/cwa-obs/*.csv`) | from first run | the truth labels: hourly Hs, Tm, direction and wind at every buoy |
| **CWA forecast archive** (`data/archive/cwa-recreation-forecast/*.csv`) | from first run | every M-B0078 issue for the spot points, to score CWA's forecast by lead time |
| ocean.cwa.gov.tw `get_station_info` (`bun run backfill:history`) | dense from ~mid-2024 at most buoys (already pulled) | truth labels; matches official data hour-for-hour |
| CMEMS WAVERYS reanalysis | 1980–2026, 0.2°, 3-hourly, swell partitions | the best free long hindcast; free Copernicus login |
| ERA5 waves (Copernicus CDS) | 1940–, 0.5° | partitions and peak period; coarse, weak in typhoons |
| Open-Meteo Historical Forecast API | MFWAM ~2022–, ECMWF ~2024–, GFS ~2025– | archived *forecasts*, exactly what you need to learn a forecast correction |
| IHMT harbour gauges | monthly CSV since 2018 | adds peak period at Su-ao and Hualien |
| NODASS | Honeymoon Bay since 2021 (needs token) | the only buoy sitting right at a surf break |

**A sensible path:**

1. **Archive (running now).** Run `bun run fetch` every 1–3 hours, so CWA's 48-hour window never leaves a gap. The ~2-year backfill from ocean.cwa.gov.tw is already in `data/archive/` (`bun run backfill:history` to refresh).
2. **Score.** Compare per-buoy, per-season and per-lead-time skill of CWA, MFWAM, GFS-Wave and ECMWF against the archive, splitting monsoon and typhoon regimes.
3. **Bias-correct (model 1).** For each buoy, regress observed Hs and period on the forecast features: model Hs, swell partitions, period, direction, wind, lead time and month. Gradient-boosted trees or even linear models work. Train on Open-Meteo historical forecasts against archived obs. This "MOS" step is what the published Taiwan ML work does at 1–24 h, and it usually beats any single raw model.
4. **Buoy to break (model 2).** Learn a per-spot transfer from offshore conditions to surf height. This needs ground truth: webcams, spot checks, or the NAMR Honeymoon Bay buoy. Spot orientation and Guishan Island's shadow matter a lot here.
5. **Typhoon handling.** Blend the ECMWF/GEFS ensembles, the ECMWF period-band heights and live readings from the far-offshore NTU and Lanyu buoys. The literature says this is where raw models fail most.

## Caveats

- Open-Meteo snaps to the nearest sea grid cell, which can be several km offshore of a spot. The spot pages show the actual cell used.
- The S3 route and ocean.cwa endpoints are undocumented; the official file API with a key goes to the same S3 objects.
- The open CWA forecast gives direction only as 16-point compass text.
- Buoy wind is measured a few metres above the sea, models report 10 m, so models read slightly higher.
