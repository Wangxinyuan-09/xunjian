# -*- coding: utf-8 -*-
"""ddddocr 识别验证码: python cap_ocr_dddd.py <图片路径> -> 输出识别文本"""
import sys, ddddocr
try:
    ocr = ddddocr.DdddOcr(show_ad=False)
    with open(sys.argv[1], 'rb') as f:
        img = f.read()
    print(ocr.classification(img))
except Exception as e:
    print('ERR', e)
