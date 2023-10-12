const shiki = require('shiki')

shiki
  .getHighlighter({
    theme: 'nord',
    langs: ['javascript']
  })
  .then((highlighter) => {
    const html = highlighter.codeToThemedTokens(
      'const sayHello = (name) => console.log("Hello, " + name)',
      'javascript'
    )
    console.log(html)
  })
