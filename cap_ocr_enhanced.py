# -*- coding: utf-8 -*-
"""增强版通用验证码 OCR：多预处理投票 + 颜色聚类 + 字符分割逐字识别
用法: python cap_ocr_enhanced.py <图片路径>  → 输出候选JSON数组（按票数排序）
适用于彩色验证码（漏扫/APT/态势感知等安恒产品）
"""
import sys, io, json
from PIL import Image
import numpy as np
import ddddocr

img = Image.open(sys.argv[1]).convert('RGB')
a = np.array(img).astype(int)
h, w, _ = a.shape

ocn = ddddocr.DdddOcr(show_ad=False)
ocb = ddddocr.DdddOcr(show_ad=False, beta=True)
cands = {}

def vote(im, weight=1):
    for ocr in (ocn, ocb):
        try:
            b = io.BytesIO(); im.save(b, format='PNG'); d = b.getvalue()
            r = ocr.classification(d).strip()
            if r:
                cands[r] = cands.get(r, 0) + weight
        except Exception:
            pass

def to_img(mask_2d):
    return Image.fromarray(np.where(mask_2d, 0, 255).astype(np.uint8))

# 1. 原图 + 放大
vote(img)
if w < 400:
    vote(img.resize((w * 2, h * 2), Image.LANCZOS))

# 2. 颜色聚类：统计主色，提取字符色区域
flat = a.reshape(-1, 3)
# 背景色 = 出现最多的颜色（白色/浅色背景）
from collections import Counter
cnt = Counter(map(tuple, (flat // 32) * 32))
bg = cnt.most_common(1)[0][0]
bg_dist = np.abs(a - np.array(bg)).sum(axis=2)
fg_mask = bg_dist > 60
if fg_mask.sum() > 30:
    vote(to_img(fg_mask), 2)

# 3. 亮度分层：中间色层（字符主体）
lum = a.sum(axis=2)
for lo, hi in [(60, 750), (100, 700), (30, 600), (50, 500)]:
    m = (lum > lo) & (lum < hi)
    if m.sum() < 30: continue
    vote(to_img(m), 1)

# 4. 反色
vote(Image.fromarray((255 - a).astype(np.uint8)), 1)

# 5. 灰度多阈值二值化
g = a.mean(axis=2)
for th in [128, 150, 180, 200]:
    for inv in [False, True]:
        m = g > th
        if inv: m = ~m
        if m.sum() < 30: continue
        vote(to_img(m), 1)

# 6. 字符分割 + 逐字识别（按列投影找字符区间）
gray = (255 - a.mean(axis=2)).astype(np.uint8)
col_sum = gray.sum(axis=0)
thr = col_sum.max() * 0.12
in_char = False
ranges = []
for x in range(w):
    if col_sum[x] > thr and not in_char:
        start = x; in_char = True
    elif col_sum[x] <= thr and in_char:
        ranges.append((start, x)); in_char = False
if in_char: ranges.append((start, w - 1))
# 合并过窄区间，限制合理字符数
if 2 <= len(ranges) <= 8:
    seg_results = []
    for (x0, x1) in ranges:
        if x1 - x0 < 2: continue
        sub = gray[:, max(0, x0 - 1):x1 + 1]
        im = Image.fromarray(sub)
        im = im.resize((im.width * 6, im.height * 6), Image.LANCZOS)
        char_cands = set()
        for ocr in (ocn, ocb):
            for th in [128, 150]:
                bw = im.point(lambda p, t=th: 255 if p > t else 0)
                buf = io.BytesIO(); bw.save(buf, format='PNG')
                try:
                    r = ocr.classification(buf.getvalue()).strip()
                    if r and len(r) <= 2: char_cands.add(r)
                except Exception:
                    pass
        seg_results.append(sorted(char_cands))
    if seg_results and all(len(c) for c in seg_results):
        combos = ['']
        for sc in seg_results:
            combos = [a2 + b2 for a2 in combos for b2 in sc[:3]]
            if len(combos) > 20: break
        for c in combos:
            cands[c] = cands.get(c, 0) + 3  # 分割识别加权

# 输出候选（过滤长度 3-8，按票数）
good = sorted([(v, k) for k, v in cands.items() if 3 <= len(k) <= 8], key=lambda x: -x[0])
res = [k for _, k in good[:12]]
print(json.dumps(res, ensure_ascii=False))
