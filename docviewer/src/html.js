"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
exports.__esModule = true;
var machine_1 = require("./machine");
var HTMLMachine = /** @class */ (function (_super) {
    __extends(HTMLMachine, _super);
    function HTMLMachine(o) {
        var _this = _super.call(this) || this;
        _this.output = o;
        _this.color = 'black';
        _this.colorStack = [];
        _this.svgDepth = 0;
        return _this;
    }
    HTMLMachine.prototype.pushColor = function (c) {
        this.colorStack.push(this.color);
        this.color = c;
    };
    HTMLMachine.prototype.popColor = function () {
        this.color = this.colorStack.pop();
    };
    HTMLMachine.prototype.setPapersize = function (width, height) {
        this.paperwidth = width;
        this.paperheight = height;
    };
    HTMLMachine.prototype.putSVG = function (svg) {
        var left = this.position.h * this.pointsPerDviUnit;
        var top = this.position.v * this.pointsPerDviUnit;
        this.svgDepth += (svg.match(/<svg>/g) || []).length;
        this.svgDepth -= (svg.match(/<\/svg>/g) || []).length;
        svg = svg.replace("<svg>", "<svg width=\"10pt\" height=\"10pt\" viewBox=\"-5 -5 10 10\" style=\"overflow: visible; position: absolute;\">");
        svg = svg.replace(/{\?x}/g, left.toString());
        svg = svg.replace(/{\?y}/g, top.toString());
        this.output.write(svg);
    };
    HTMLMachine.prototype.preamble = function (numerator, denominator, magnification, comment) {
        var dviUnit = magnification * numerator / 1000.0 / denominator;
        var resolution = 300.0; // ppi
        var tfm_conv = (25400000.0 / numerator) * (denominator / 473628672) / 16.0;
        var conv = (numerator / 254000.0) * (resolution / denominator);
        conv = conv * (magnification / 1000.0);
        this.pointsPerDviUnit = dviUnit * 72.27 / 100000.0 / 2.54;
    };
    HTMLMachine.prototype.putRule = function (rule) {
        var a = rule.a * this.pointsPerDviUnit;
        var b = rule.b * this.pointsPerDviUnit;
        var left = this.position.h * this.pointsPerDviUnit;
        var bottom = this.position.v * this.pointsPerDviUnit;
        var top = bottom - a;
        this.output.write("<span style=\"background: " + this.color + "; position: absolute; top: " + top + "pt; left: " + left + "pt; width:" + b + "pt; height: " + a + "pt;\"></span>\n");
    };
    HTMLMachine.prototype.putText = function (text) {
        return 0;
    };
    return HTMLMachine;
}(machine_1.Machine));
exports["default"] = HTMLMachine;