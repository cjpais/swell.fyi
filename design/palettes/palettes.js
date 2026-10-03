// Riso palettes: the Riso almanac treatment with two ink sets, Blue + pink and Overprint.
// Each palette is just CSS tokens (palettes.css); the page is otherwise identical.
import { specimen } from "/styles/specimen.js";

const sw = (...hex) => hex.map((h) => `<i class="pl-sw" style="background:${h}"></i>`).join("");
const styles = [
  { id: "riso", name: "Blue + pink", zh: "藍粉", brand: "台灣浪況", blurb: `${sw("#1f3a73", "#c35775")} The Riso almanac: federal blue and pink.` },
  { id: "op-yellow", name: "Overprint", zh: "藍粉黃", brand: "台灣浪況", blurb: `${sw("#233f7a", "#e2557c", "#f0b419")} Brighter blue, fluorescent pink and yellow: a yellow header bar and three-tone headlines.` },
];
specimen({ styles, extras: false });
