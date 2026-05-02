(function () {
  const theme = localStorage.getItem('theme') || 'system';
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
  document.documentElement.style.setProperty('color-scheme', isDark ? 'dark' : 'light');
})();
