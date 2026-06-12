const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const config = {
  entryPoints: ['src/offscreen.js'],
  bundle: true,
  outdir: 'dist',
  entryNames: 'offscreen',
  chunkNames: 'chunks/[name]-[hash]',
  format: 'esm',
  splitting: true,
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
    console.log('[build] dist/offscreen.js built successfully');
  });
}
