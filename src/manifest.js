export default {
  manifest_version: 3,
  name: 'Veil — Local AI Image Detector',
  short_name: 'Veil',
  version: '1.2.0',
  description: 'Scores every visible image for AI generation on-device, then blurs or hides likely-AI images. No uploads.',
  minimum_chrome_version: '116',
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png'
  },
  permissions: ['storage', 'offscreen', 'activeTab', 'contextMenus'],
  host_permissions: ['http://*/*', 'https://*/*'],
  background: {
    service_worker: 'src/background/index.js',
    type: 'module'
  },
  action: {
    default_title: 'Veil',
    default_popup: 'src/popup/popup.html',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png'
    }
  },
  options_page: 'src/options/options.html',
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/index.js'],
      css: ['src/content/overlay.css'],
      run_at: 'document_idle',
      all_frames: true
    }
  ],
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },
  cross_origin_embedder_policy: { value: 'credentialless' },
  cross_origin_opener_policy: { value: 'same-origin' },
  web_accessible_resources: [
    {
      resources: [
        'src/offscreen/offscreen.html',
        'assets/*',
        'wasm/*',
        'models/*'
      ],
      matches: ['http://*/*', 'https://*/*']
    }
  ]
};
