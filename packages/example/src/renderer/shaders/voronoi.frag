// Voronoi Cells + Flow Field - Fragment Shader
// Audio-driven distortion with organic cell animation

precision highp float;

uniform float u_time;
uniform vec2 u_resolution;
uniform float u_bass;
uniform float u_mid;
uniform float u_high;
uniform float u_beat;

varying vec2 v_uv;

#define PI 3.14159265359
#define TAU 6.28318530718

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)),
           dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

vec3 palette(float t) {
  vec3 a = vec3(0.5, 0.5, 0.5);
  vec3 b = vec3(0.5, 0.5, 0.5);
  vec3 c = vec3(2.0, 1.0, 0.0);
  vec3 d = vec3(0.5, 0.2, 0.25);
  d += vec3(u_bass * 0.2, u_mid * 0.3, u_high * 0.2);
  return a + b * cos(TAU * (c * t + d));
}

// Voronoi with distance to nearest cell and cell ID
vec3 voronoi(vec2 p) {
  vec2 ip = floor(p);
  vec2 fp = fract(p);

  float md = 8.0;
  float md2 = 8.0;
  vec2 mg = vec2(0.0);

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash2(ip + g);

      // Animate cell centers
      o = 0.5 + 0.5 * sin(u_time * 0.5 + TAU * o + u_bass * 0.3);

      vec2 r = g + o - fp;
      float d = dot(r, r);

      if (d < md) {
        md2 = md;
        md = d;
        mg = g;
      } else if (d < md2) {
        md2 = d;
      }
    }
  }

  // md = distance to nearest, md2 = distance to second nearest
  return vec3(md, md2, md2 - md);
}

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_resolution.x / u_resolution.y;

  float t = u_time;
  float beat = u_beat;

  // Flow field distortion
  float flowAngle = sin(uv.x * 2.0 + t * 0.3) * cos(uv.y * 2.0 + t * 0.4);
  flowAngle += u_bass * sin(uv.y * 4.0 + t);
  vec2 flow = vec2(cos(flowAngle), sin(flowAngle)) * 0.3;

  // Audio-driven warp
  vec2 warp = uv + flow;
  warp += vec2(sin(t * 0.7), cos(t * 0.5)) * beat * 0.2;

  // Scale for cell density
  float scale = 4.0 + u_mid * 2.0;
  vec3 vor = voronoi(warp * scale);

  float d1 = sqrt(vor.x);   // distance to nearest center
  float d2 = sqrt(vor.y);   // distance to second nearest
  float edge = vor.z;        // cell border proximity

  // Cell coloring
  vec2 cellId = floor(warp * scale) + 0.5;
  float cellHash = fract(sin(dot(cellId, vec2(12.9898, 78.233))) * 43758.5453);

  vec3 cellCol = palette(cellHash + t * 0.05);
  cellCol *= 0.5 + u_bass * 0.3;

  // Edge lines
  float edgeWidth = 0.05 + u_high * 0.03;
  float edgeLine = smoothstep(edgeWidth, edgeWidth + 0.02, edge);

  // Interior gradient
  float innerGlow = 1.0 - smoothstep(0.0, 0.5, d1);
  cellCol *= 0.4 + innerGlow * 0.8;

  // Edge color (brighter, audio-reactive)
  vec3 edgeCol = palette(t * 0.1 + 0.5) * (1.5 + u_mid);

  vec3 col = mix(edgeCol, cellCol, edgeLine);

  // Beat pulse: flash cells outward
  float pulse = beat * (1.0 - d1) * 2.0;
  col += palette(t * 0.2) * pulse;

  // Background glow through edges
  float bgGlow = (1.0 - edgeLine) * 0.3;
  col += palette(d1 * 2.0 + t * 0.08) * bgGlow * (1.0 + u_high);

  // Second layer: subtle large-scale voronoi
  vec3 vor2 = voronoi(warp * 1.5 + t * 0.1);
  float largeCellEdge = smoothstep(0.1, 0.15, vor2.z);
  col *= 0.7 + largeCellEdge * 0.3;

  // Vignette
  float vignette = 1.0 - length(v_uv - 0.5) * 0.8;
  col *= vignette;

  // Beat flash on edges
  if (beat > 0.1) {
    col.g *= 1.0 + beat * 0.15;
    col.b *= 1.0 + beat * 0.1;
  }

  // Scanlines
  float scanline = sin(v_uv.y * u_resolution.y * 2.0) * 0.02 + 1.0;
  col *= scanline;

  // Gamma correction
  col = pow(col, vec3(0.4545));
  col = clamp(col, 0.0, 1.0);

  gl_FragColor = vec4(col, 1.0);
}
