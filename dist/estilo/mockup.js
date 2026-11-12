(function () {
  var photo = document.getElementById("estilo-photo");
  var canvas = document.getElementById("estilo-mockup");
  var picker = document.querySelector(".estilo-picker");
  if (!photo || !canvas || !picker) return;

  var label = document.getElementById("estilo-color-label");
  var stage = canvas.parentElement;
  var source = null;
  var median = 80;
  var buttons = Array.prototype.slice.call(picker.querySelectorAll("[data-color]"));

  function lum(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function kind(r, g, b) {
    var mx = Math.max(r, g, b);
    var mn = Math.min(r, g, b);
    var sat = mx === 0 ? 0 : (mx - mn) / mx;
    var L = lum(r, g, b);
    if (mn > 232 && sat < 0.12) return "bg";
    if (r > 150 && g > 110 && b < 100 && r > b + 50) return "print";
    if (L > 205 && sat < 0.22) return "print";
    if (median && L > median * 2.15 && sat < 0.35) return "print";
    if (r > 130 && r > g + 25 && r > b + 35 && sat > 0.4 && L > 30 && L < 190) return "trim";
    return "cloth";
  }

  function parse(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function prepare() {
    var w = photo.naturalWidth;
    var h = photo.naturalHeight;
    if (!w || !h) return;
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(photo, 0, 0, w, h);
    source = ctx.getImageData(0, 0, w, h);
    var lums = [];
    var d = source.data;
    for (var i = 0; i < d.length; i += 16) {
      if (kind(d[i], d[i + 1], d[i + 2]) === "cloth") lums.push(lum(d[i], d[i + 1], d[i + 2]));
    }
    lums.sort(function (a, b) { return a - b; });
    median = lums.length ? lums[Math.floor(lums.length / 2)] : 80;
    if (median < 12) median = 12;
  }

  function paint(hex, name) {
    if (!source) return;
    var rgb = parse(hex);
    var out = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
    var d = out.data;
    for (var i = 0; i < d.length; i += 4) {
      var r = d[i], g = d[i + 1], b = d[i + 2];
      if (kind(r, g, b) !== "cloth") continue;
      var shade = lum(r, g, b) / median;
      if (shade < 0.42) shade = 0.42;
      if (shade > 1.65) shade = 1.65;
      d[i] = Math.min(255, rgb[0] * shade);
      d[i + 1] = Math.min(255, rgb[1] * shade);
      d[i + 2] = Math.min(255, rgb[2] * shade);
    }
    canvas.getContext("2d").putImageData(out, 0, 0);
    stage.classList.add("estilo-mockup-ready");
    buttons.forEach(function (btn) {
      btn.classList.toggle("is-selected", btn.getAttribute("data-color").toLowerCase() === hex.toLowerCase());
    });
    if (label) label.textContent = name;
    canvas.setAttribute("aria-label", photo.alt + ", " + name);
  }

  function boot() {
    prepare();
    var start = buttons.filter(function (btn) {
      return btn.getAttribute("data-color").toLowerCase() === (picker.getAttribute("data-default") || "").toLowerCase();
    })[0] || buttons[0];
    if (start) paint(start.getAttribute("data-color"), start.getAttribute("data-name"));
  }

  picker.addEventListener("click", function (event) {
    var btn = event.target.closest("[data-color]");
    if (!btn) return;
    paint(btn.getAttribute("data-color"), btn.getAttribute("data-name"));
  });

  if (photo.complete && photo.naturalWidth) boot();
  else photo.addEventListener("load", boot);
})();
