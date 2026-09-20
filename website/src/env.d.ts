/// <reference types="vite/client" />
declare module 'virtual:docs' {
  const pages: import('./pages').DocPage[];
  export default pages;
}
