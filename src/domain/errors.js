"use strict";

// 统一业务错误：code 映射 HTTP 状态
// NOT_FOUND=404  INVALID=400  CONFLICT=409（寿命不足/未校准/占用等整批返回 409）
class BusinessError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "BusinessError";
    this.code = code;
    this.status = BusinessError.STATUS[code] || 400;
    this.details = details;
  }
}

BusinessError.STATUS = {
  NOT_FOUND: 404,
  INVALID: 400,
  CONFLICT: 409
};

module.exports = { BusinessError };
