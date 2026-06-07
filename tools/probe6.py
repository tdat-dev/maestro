import numpy as np
from PIL import Image
arr=np.array(Image.open(r'C:\Users\tvmar\.claude\image-cache\c01ed771-bd47-4846-b4e2-547271e516b0\1.png').convert('RGB')).astype(np.int16)
H,W,_=arr.shape
white=(arr>245).all(axis=2)
R,G,B=arr[:,:,0],arr[:,:,1],arr[:,:,2]
mx=arr.max(2);mn=arr.min(2);sat=mx-mn
label=(R>=G-5)&(G>=B-5)&(mx>140)&(mx<225)&(sat<55)&(mn>110)
content=(~white)&(~label)
y0,y1=1020,1154
colh=content[y0:y1].sum(0)
# print colh per 20px
print("W",W)
print(" ".join(f"{int(colh[i:i+20].max())}" for i in range(0,W,20)))
