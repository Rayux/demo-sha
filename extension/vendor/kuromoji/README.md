Vendored from the official npm package kuromoji@0.1.2 (Apache-2.0), including its IPADIC dictionary and license notices.
Package shasum: 293f0d6706df006112137980588d5daac26d0790.
Local change: dictionary path joining uses URL-safe string concatenation instead of Node path.join, which collapses the double slash in chrome-extension:// URLs.
No dictionary or code is fetched from a remote service at runtime.
