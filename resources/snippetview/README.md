### Overview

`snippetpanel.json` is generated by `dev/createSymbolSvgs.ts`. `snippetpanel.json` includes all the SVG texts to display on the snippet view. They are loaded by the extension host and are send to the WebView View.

The content of the tab of `TikZ`, including SVG files, is directly written on the HTML file.

### PDF.js

We load PDF.js inside the WebView of the Snippet View to render the thumbnails of PDF files for hovers.
