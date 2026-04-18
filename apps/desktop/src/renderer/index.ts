const N = 1000;
const DT = 10;

function synthTransitions(): { buf: ArrayBuffer; count: number; tMax: number } {
  const count = N;
  const ab = new ArrayBuffer(count * 12);
  const f = new Float32Array(ab);
  const u = new Uint32Array(ab);
  for (let i = 0; i < count; i++) {
    let v = i & 1;
    if (i === 100 || i === 200) v = 2;
    if (i === 300 || i === 400) v = 3;
    if (i >= 500 && i < 520) v = 0;
    f[i * 3 + 0] = i * DT;
    f[i * 3 + 1] = DT;
    u[i * 3 + 2] = v;
  }
  return { buf: ab, count, tMax: count * DT };
}

const VS = `#version 300 es
precision highp float;
layout(location=0) in float a_t;
layout(location=1) in float a_dt;
layout(location=2) in uint a_v;
uniform float u_t_origin;
uniform float u_px_per_t;
uniform float u_row_y;
uniform float u_row_h;
uniform float u_canvas_w;
uniform float u_canvas_h;
out vec4 v_color;

void main() {
  vec2 corners[6] = vec2[6](
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
    vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
  );
  vec2 c = corners[gl_VertexID];
  float x_start = (a_t - u_t_origin) * u_px_per_t;
  float x_end   = (a_t + a_dt - u_t_origin) * u_px_per_t;
  float bar_h = 2.0;
  float y_top; float y_bot; vec4 color;
  if (a_v == 0u) {
    y_top = u_row_y + u_row_h - bar_h;
    y_bot = u_row_y + u_row_h;
    color = vec4(0.40, 0.80, 0.60, 1.0);
  } else if (a_v == 1u) {
    y_top = u_row_y;
    y_bot = u_row_y + bar_h;
    color = vec4(0.40, 1.00, 0.60, 1.0);
  } else if (a_v == 2u) {
    y_top = u_row_y;
    y_bot = u_row_y + u_row_h;
    color = vec4(0.95, 0.35, 0.35, 0.55);
  } else {
    y_top = u_row_y;
    y_bot = u_row_y + u_row_h;
    color = vec4(0.95, 0.85, 0.25, 0.55);
  }
  float x_px = mix(x_start, x_end, c.x);
  float y_px = mix(y_top, y_bot, c.y);
  float x_clip = 2.0 * x_px / u_canvas_w - 1.0;
  float y_clip = 1.0 - 2.0 * y_px / u_canvas_h;
  gl_Position = vec4(x_clip, y_clip, 0.0, 1.0);
  v_color = color;
}
`;

const FS = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }
`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error("shader compile: " + gl.getShaderInfoLog(s));
  }
  return s;
}

function link(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("program link: " + gl.getProgramInfoLog(p));
  }
  return p;
}

function init(): void {
  const canvas = document.getElementById("gpu") as HTMLCanvasElement | null;
  if (!canvas) throw new Error("canvas#gpu missing");

  const gl = canvas.getContext("webgl2", { alpha: false, antialias: true });
  if (!gl) {
    document.body.innerText = "WebGL2 not available";
    return;
  }

  const program = link(gl, compile(gl, gl.VERTEX_SHADER, VS), compile(gl, gl.FRAGMENT_SHADER, FS));
  const uloc = {
    t_origin: gl.getUniformLocation(program, "u_t_origin"),
    px_per_t: gl.getUniformLocation(program, "u_px_per_t"),
    row_y: gl.getUniformLocation(program, "u_row_y"),
    row_h: gl.getUniformLocation(program, "u_row_h"),
    canvas_w: gl.getUniformLocation(program, "u_canvas_w"),
    canvas_h: gl.getUniformLocation(program, "u_canvas_h"),
  };

  const { buf, count, tMax } = synthTransitions();

  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const ibuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
  gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);

  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 12, 0);
  gl.vertexAttribDivisor(0, 1);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 4);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 12, 8);
  gl.vertexAttribDivisor(2, 1);

  gl.bindVertexArray(null);

  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
  };
  resize();
  window.addEventListener("resize", resize);

  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const frame = (): void => {
    const w = canvas.width;
    const h = canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.063, 0.071, 0.086, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(program);
    const rowH = Math.min(120, h * 0.4);
    const rowY = (h - rowH) / 2;
    gl.uniform1f(uloc.t_origin, 0);
    gl.uniform1f(uloc.px_per_t, w / tMax);
    gl.uniform1f(uloc.row_y, rowY);
    gl.uniform1f(uloc.row_h, rowH);
    gl.uniform1f(uloc.canvas_w, w);
    gl.uniform1f(uloc.canvas_h, h);

    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    gl.bindVertexArray(null);

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  console.log(`riptide: ${count} transitions, tMax=${tMax}, WebGL2`);
}

try {
  init();
} catch (e) {
  console.error(e);
  document.body.innerText = String(e);
}
