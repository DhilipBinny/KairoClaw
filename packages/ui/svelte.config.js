import adapter from '@sveltejs/adapter-static';

export default {
  onwarn: (warning, handler) => {
    if (warning.code === 'css_unused_selector') return;
    if (warning.code?.startsWith('a11y')) return;
    handler(warning);
  },
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
    }),
  },
};
