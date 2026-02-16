// Audio-Reactive Julia Set Fractal - Fragment Shader
// Smooth color cycling with audio-driven zoom and parameter morphing

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
#define MAX_ITER 128

vec3 palette(float t) {
  vec3 a = vec3(0.5, 0.5, 0.5);
  vec3 b = vec3(0.5, 0.5, 0.5);
  vec3 c = vec3(1.0, 1.0, 0.5);
  vec3 d = vec3(0.8, 0.9, 0.3);
  d += vec3(u_bass * 0.3, u_mid * 0.2, u_high * 0.4);
  return a + b * cos(TAU * (c * t + d));
}

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_resolution.x / u_resolution.y;

  float t = u_time;
  float beat = u_beat;

  // Audio-reactive zoom
  float zoom = 1.5 + sin(t * 0.2) * 0.8 + u_bass * 0.3;
  uv *= zoom;

  // Orbit the Julia set parameter in the complex plane
  float angle = t * 0.15;
  vec2 c = vec2(
    -0.7 + sin(angle) * 0.15 + u_mid * 0.05,
    0.27015 + cos(angle * 1.3) * 0.1 + u_high * 0.03
  );

  // Beat-triggered parameter kick
  c += vec2(sin(t * 3.0), cos(t * 2.7)) * beat * 0.05;

  // Julia set iteration
  vec2 z = uv;
  float iter = 0.0;
  float smooth_iter = 0.0;

  for (int i = 0; i < MAX_ITER; i++) {
    // z = z^2 + c
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;

    if (dot(z, z) > 256.0) {
      // Smooth iteration count for anti-banding
      smooth_iter = iter - log2(log2(dot(z, z))) + 4.0;
      break;
    }
    iter += 1.0;
    smooth_iter = iter;
  }

  // Color mapping
  vec3 col;
  if (iter >= float(MAX_ITER) - 1.0) {
    // Interior: dark with subtle bass pulse
    col = vec3(0.02, 0.01, 0.03) * (1.0 + u_bass * 0.5);
  } else {
    // Exterior: palette-based coloring with time cycling
    float normalized = smooth_iter / float(MAX_ITER);
    float colorIndex = sqrt(normalized) * 4.0 + t * 0.1;
    col = palette(colorIndex);

    // Brightness modulation from audio
    col *= 0.6 + u_bass * 0.3 + u_mid * 0.2;

    // Beat flash
    col += vec3(0.2, 0.1, 0.3) * beat;
  }

  // Edge glow at escape boundary
  float edgeDist = smooth_iter / float(MAX_ITER);
  float glow = exp(-edgeDist * 8.0) * (0.5 + u_high * 0.5);
  col += palette(t * 0.05 + 0.5) * glow;

  // Vignette
  float vignette = 1.0 - length(v_uv - 0.5) * 0.8;
  col *= vignette;

  // Scanlines
  float scanline = sin(v_uv.y * u_resolution.y * 2.0) * 0.02 + 1.0;
  col *= scanline;

  // Gamma correction
  col = pow(col, vec3(0.4545));
  col = clamp(col, 0.0, 1.0);

  gl_FragColor = vec4(col, 1.0);
}
