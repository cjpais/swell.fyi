// Curated surf spots. Coordinates are approximate beach locations.
// `cwaPoint` is the nearest point in CWA's recreation sea forecast (M-B0078-001);
// some points are shared between spots, and some CWA points share coordinates.
// `buoys` are CWA marine station IDs (O-B0075-001), nearest/most relevant first.
// `faces` is a rough beach orientation, for reading swell direction. Approximate.
// `model` is a point a few km offshore, inside the spot's swell window, used for model
// requests. Each model then snaps to its nearest sea cell (shown on the spot page).

export type Spot = {
  id: string;
  name: string;
  nameZh: string;
  region: string;
  lat: number;
  lon: number;
  model: [number, number];
  faces: string;
  cwaPoint: string;
  buoys: string[];
  notes?: string;
};

export const REGIONS = [
  "North coast",
  "Yilan",
  "Hualien",
  "Taitung",
  "Kenting / Pingtung",
  "West & islands",
] as const;

export const SPOTS: Spot[] = [
  {
    id: "zhongjiao", name: "Zhongjiao Bay", nameZh: "中角沙珠灣", region: "North coast",
    lat: 25.240, lon: 121.636, model: [25.28, 121.64], faces: "N", cwaPoint: "O00100", buoys: ["C6AH2", "OAC004"],
  },
  {
    id: "fulong", name: "Fulong", nameZh: "福隆", region: "North coast",
    lat: 25.024, lon: 121.950, model: [25.05, 121.98], faces: "NE", cwaPoint: "O00300", buoys: ["46694A", "OAC003", "C4A05"],
  },
  {
    id: "honeymoon-bay", name: "Honeymoon Bay (Daxi)", nameZh: "蜜月灣", region: "Yilan",
    lat: 24.935, lon: 121.893, model: [24.935, 121.94], faces: "E", cwaPoint: "O01200", buoys: ["OAC005", "46708A", "46694A"],
  },
  {
    id: "wushi", name: "Wushi Harbor / Double Lions", nameZh: "烏石港 / 雙獅", region: "Yilan",
    lat: 24.873, lon: 121.840, model: [24.873, 121.89], faces: "E", cwaPoint: "O00400", buoys: ["46708A", "OAC005", "C4U02"],
    notes: "Guishan Island (龜山島) partly shadows this stretch from E/SE swell.",
  },
  {
    id: "dongao", name: "Dong'ao", nameZh: "東澳", region: "Yilan",
    lat: 24.517, lon: 121.833, model: [24.517, 121.88], faces: "E", cwaPoint: "B00300", buoys: ["46706A", "C4U01"],
  },
  {
    id: "hualien", name: "Hualien (Beibin / city)", nameZh: "花蓮北濱", region: "Hualien",
    lat: 23.985, lon: 121.627, model: [23.985, 121.67], faces: "E", cwaPoint: "I06100", buoys: ["46699A", "C4T01"],
  },
  {
    id: "shitiping", name: "Shitiping", nameZh: "石梯坪", region: "Hualien",
    lat: 23.487, lon: 121.513, model: [23.487, 121.56], faces: "E", cwaPoint: "I06200", buoys: ["1566", "46761F", "46699A"],
  },
  {
    id: "chenggong", name: "Chenggong", nameZh: "成功", region: "Taitung",
    lat: 23.100, lon: 121.380, model: [23.1, 121.43], faces: "E", cwaPoint: "I01000", buoys: ["46761F", "C4S02"],
  },
  {
    id: "donghe", name: "Donghe River Mouth", nameZh: "東河", region: "Taitung",
    lat: 22.970, lon: 121.307, model: [22.96, 121.35], faces: "E/SE", cwaPoint: "O01300", buoys: ["46761F", "WRA007"],
    notes: "No dedicated CWA forecast point; uses Jinzun (金樽), about 2 km south.",
  },
  {
    id: "jinzun", name: "Jinzun", nameZh: "金樽", region: "Taitung",
    lat: 22.956, lon: 121.295, model: [22.94, 121.34], faces: "SE", cwaPoint: "O01300", buoys: ["46761F", "WRA007"],
  },
  {
    id: "shanyuan", name: "Shanyuan", nameZh: "杉原", region: "Taitung",
    lat: 22.830, lon: 121.195, model: [22.82, 121.24], faces: "E/SE", cwaPoint: "A01900", buoys: ["WRA007", "46761F"],
  },
  {
    id: "jialeshui", name: "Jialeshui / Gangkou", nameZh: "佳樂水 / 港口", region: "Kenting / Pingtung",
    lat: 21.990, lon: 120.848, model: [21.99, 120.89], faces: "E", cwaPoint: "O01000", buoys: ["46759A", "OAC007"],
  },
  {
    id: "nanwan", name: "Nanwan", nameZh: "南灣", region: "Kenting / Pingtung",
    lat: 21.959, lon: 120.761, model: [21.92, 120.76], faces: "S", cwaPoint: "O00700", buoys: ["OAC007", "46759A", "C4Q03"],
  },
  {
    id: "baisha", name: "Baisha", nameZh: "白砂", region: "Kenting / Pingtung",
    lat: 21.933, lon: 120.719, model: [21.93, 120.68], faces: "W/SW", cwaPoint: "O00600", buoys: ["OAC007", "46759A"],
  },
  {
    id: "daan", name: "Da'an (Taichung)", nameZh: "大安", region: "West & islands",
    lat: 24.388, lon: 120.584, model: [24.39, 120.53], faces: "W", cwaPoint: "O00500", buoys: ["C6F01"],
  },
  {
    id: "shanshui", name: "Shanshui (Penghu)", nameZh: "山水", region: "West & islands",
    lat: 23.513, lon: 119.591, model: [23.48, 119.59], faces: "S", cwaPoint: "O01100", buoys: ["46735A", "C6W10"],
  },
];

export const spotById = (id: string) => SPOTS.find((s) => s.id === id);
