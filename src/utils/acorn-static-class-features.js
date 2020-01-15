"use strict"

const acorn = require("acorn")
const tt = acorn.tokTypes

function maybeParseFieldValue(field) {
  if (this.eat(tt.eq)) {
    const oldInFieldValue = this._inStaticFieldValue
    this._inStaticFieldValue = true
    field.value = this.parseExpression()
    this._inStaticFieldValue = oldInFieldValue
  } else field.value = null
}

const privateClassElements = require("acorn-private-class-elements")

module.exports = function(Parser) {
  const ExtendedParser = privateClassElements(Parser)

  return class extends ExtendedParser {
    // Parse fields
    parseClassElement(_constructorAllowsSuper) {
      if (this.options.ecmaVersion < 8 || !this.isContextual("static")) {
        return super.parseClassElement.apply(this, arguments)
      }

      const branch = this._branch()
      branch.next()
      if ([tt.name, tt.bracketL, tt.string, this.privateNameToken].indexOf(branch.type) == -1) {
        return super.parseClassElement.apply(this, arguments)
      }
      if (branch.type == tt.bracketL) {
        let count = 0
        do {
          if (branch.eat(tt.bracketL)) ++count
          else if (branch.eat(tt.bracketR)) --count
          else branch.next()
        } while (count > 0)
      } else branch.next()
      if (branch.type != tt.eq && !branch.canInsertSemicolon() && branch.type != tt.semi) {
        return super.parseClassElement.apply(this, arguments)
      }

      const node = this.startNode()
      node.static = this.eatContextual("static")
      if (this.type == this.privateNameToken) {
        this.parsePrivateClassElementName(node)
      } else {
        this.parsePropertyName(node)
      }
      if ((node.key.type === "Identifier" && node.key.name === "constructor") ||
          (node.key.type === "Literal" && !node.computed && node.key.value === "constructor")) {
        this.raise(node.key.start, "Classes may not have a field called constructor")
      }
      if ((node.key.name || node.key.value) === "prototype" && !node.computed) {
        this.raise(node.key.start, "Classes may not have a static property named prototype")
      }

      maybeParseFieldValue.call(this, node)
      this.finishNode(node, "FieldDefinition")
      this.semicolon()
      return node
    }

    // Parse private static methods
    parsePropertyName(prop) {
      if (prop.static && this.type == this.privateNameToken) {
        this.parsePrivateClassElementName(prop)
      } else {
        super.parsePropertyName(prop)
      }
    }

    // Prohibit arguments in class field initializers
    parseIdent(liberal, isBinding) {
      const ident = super.parseIdent(liberal, isBinding)
      if (this._inStaticFieldValue && ident.name == "arguments") this.raise(ident.start, "A static class field initializer may not contain arguments")
      return ident
    }
  }
}