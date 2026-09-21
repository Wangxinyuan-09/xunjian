# -*- coding: utf-8 -*-
"""漏扫/APT 彩色验证码识别 — 多模型 x 轻预处理 的整图识别

【2026-09-20 重写。原实现是坏的，且它制造了"彩色验证码 OCR 识别率低"的错误结论】
坏在哪: 原实现先做连通域标记, 再按 "x 间隔 <= 6px 就合并" 归并。
  但这类验证码的 4 个字符是**横向重叠**的 —— 实测 captcha_work/diag/page_cap.jpg 上
  ink 连通域连成一片 x[47-176], 连通域【物理上无法把字符分开】。
  结果 merged 只剩 1 块, 整串被当成一个"字符"识别 → 输出 bmnaj / bnj / hnaj 之类垃圾。
  更糟: xunjian_lib.parseOcrOutput('ls') 还把这些"逐字符候选"做笛卡尔组合展开,
  生成一串垃圾并排在正确候选【前面】。而漏扫验证码是【一次性】的(一张图只能提交一次),
  第一个垃圾候选就把验证码消耗掉了 → 正确的 ddddocr 结果永远没机会提交 → 登录全败。
  (2026-09-04 因此误判为"OCR 识别率低, 只能人工登录")

【实测依据】(2026-09-20, 两张已知真值的图: page_cap=bnad, r1=f6nc)
  原图 / 灰度 / 灰度x3 / Otsu / autocontrast —— 8 种变体在两张图上【全部命中】
  但硬二值化(sat>25 黑字白底)会让 default 模型把 6 读成 B → 所以【不做硬二值化】
  结论: 原图和灰度变体最稳; 放大无害; 二值化有害。就按这个来。

【另一个发现】cap_ocr_dddd.py(即 'ddd' 引擎)只用了 default 模型, 没用 beta。
  beta 模型在实验里多次给出正确答案, 所以这里两个模型都跑, 组成互补候选。

输出(供 xunjian_lib.parseOcrOutput 解析):
  whole: ["bnad", "bna0", ...]     <- 整图识别候选, 按可信度排序
"""
import sys, io, json
from PIL import Image, ImageOps
import numpy as np

img_path = sys.argv[1]

try:
    import ddddocr
    ocn = ddddocr.DdddOcr(show_ad=False)
    ocb = ddddocr.DdddOcr(show_ad=False, beta=True)
except Exception as e:
    print('ERR', e)
    sys.exit(0)


def recog(im):
    """一张 PIL 图 → default + beta 两个模型的识别结果(可能为空)"""
    buf = io.BytesIO()
    im.save(buf, format='PNG')
    data = buf.getvalue()
    res = []
    for o in (ocn, ocb):
        try:
            r = (o.classification(data) or '').strip().replace(' ', '')
            if r:
                res.append(r)
        except Exception:
            pass
    return res


def variants(path):
    """按实测有效顺序产出变体: 原图 → 灰度 → 灰度放大。
    刻意【不做】硬二值化: 实测它会把 6 打成 B(sat>25 那次), 掉分不讨好。"""
    im = Image.open(path).convert('RGB')
    out = [im]
    g = im.convert('L').convert('RGB')
    out.append(g)
    for s in (2, 3):
        out.append(g.resize((g.width * s, g.height * s), Image.LANCZOS))
    try:
        out.append(ImageOps.autocontrast(im.convert('L')).convert('RGB'))
    except Exception:
        pass
    return out


cands = []
seen = set()
for im in variants(img_path):
    for r in recog(im):
        if r not in seen:
            seen.add(r)
            cands.append(r)
    # 前两个变体(原图/灰度)若已出结果就不再往后试, 省时间
    if len(cands) >= 2:
        break

print('whole: ' + json.dumps(cands, ensure_ascii=False))
