const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const config = {
  entryPoints: ['src/offscreen.js'],
  bundle: true,
  outfile: 'dist/offscreen.bundle.js',
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  define: {
    'process.env.NODE_ENV': watch ? '"development"' : '"production"',
  },
};

if (watch) {
  esbuild.context(config).then((ctx) => {
    ctx.watch();
    console.log('[build] Watching for changes...');
  });
} else {
  esbuild.build(config).then(() => {
    console.log('[build] offscreen.bundle.js built successfully');
  });
}
