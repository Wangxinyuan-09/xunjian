# 堡垒机验证码识别 v3: 大投票池(中间色层/亮色层/原图/反色/多阈值) 聚类投票
import sys, io, json
from PIL import Image
import numpy as np
import ddddocr

img = Image.open(sys.argv[1]).convert('L')
a = np.array(img)
ocn = ddddocr.DdddOcr(show_ad=False)
ocb = ddddocr.DdddOcr(show_ad=False, beta=True)

cands = {}
def vote(im):
    for ocr in (ocn, ocb):
        b = io.BytesIO(); im.save(b, format='PNG'); d = b.getvalue()
        try:
            r = ocr.classification(d).strip()
            if r: cands[r] = cands.get(r, 0) + 1
        except Exception:
            pass

# 原图
vote(img)
vote(img.resize((480, 160), Image.LANCZOS))
# 反色
inv = Image.fromarray((255 - a).astype(np.uint8))
vote(inv.resize((480, 160), Image.LANCZOS))
# 中间色层黑色前景(字符主体) + 亮色层 + 合并层
for lo, hi in [(30, 100), (40, 90), (50, 90), (45, 85), (40, 100), (30, 120)]:
    m = (a >= lo) & (a <= hi)
    out = np.where(m, 0, 255).astype(np.uint8)
    im = Image.fromarray(out)
    vote(im.resize((480, 160), Image.LANCZOS))
# 亮色层>200
m = a >= 200
out = np.where(m, 0, 255).astype(np.uint8)
vote(Image.fromarray(out).resize((480, 160), Image.LANCZOS))
# 合并层>30
m = a >= 30
out = np.where(m, 0, 255).astype(np.uint8)
vote(Image.fromarray(out).resize((480, 160), Image.LANCZOS))
# 固定阈值
for th in (128, 160, 200):
    bw = img.point(lambda p: 255 if p > th else 0)
    vote(bw.resize((480, 160), Image.LANCZOS))

# 按票数排序, 过滤长度3-6, 输出候选 + 票数
good = sorted([(v, k) for k, v in cands.items() if 3 <= len(k) <= 6], key=lambda x: -x[0])
print(json.dumps([k for _, k in good[:8]], ensure_ascii=False))
