#!/usr/bin/env python3
"""Extra background music beds (royalty-free, synthesized) so videos vary their sound.
Outputs: beat-drive.wav, beat-lofi.wav, beat-trap.wav  (into public/audio/).
Run: python3 gen_audio_beds.py
"""
import wave, math, struct, random, os
SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public', 'audio')

def save(name, s):
    with wave.open(os.path.join(OUT, name), 'w') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, v)) * 32767)) for v in s))
    print(f"  {name} ({len(s)/SR:.1f}s)")

def kick(dur=0.18, f0=120, drop=22):
    return [0.9*math.exp(-9*(i/SR))*math.sin(2*math.pi*(f0*math.exp(-drop*(i/SR))+45)*(i/SR)) for i in range(int(SR*dur))]
def sub808(dur=0.5, f=55):
    return [0.8*math.exp(-3.2*(i/SR))*math.sin(2*math.pi*f*(i/SR)) for i in range(int(SR*dur))]
def snare(dur=0.2):
    return [(0.5*math.exp(-22*(i/SR))*random.uniform(-1,1) + 0.3*math.exp(-26*(i/SR))*math.sin(2*math.pi*190*(i/SR))) for i in range(int(SR*dur))]
def clap(dur=0.22):
    o=[0.0]*int(SR*dur)
    for d in (0,0.012,0.024):
        for i in range(int(SR*0.06)):
            p=int(d*SR)+i
            if p<len(o): o[p]+=0.45*math.exp(-40*(i/SR))*random.uniform(-1,1)
    return o
def hat(dur=0.05, v=0.22):
    return [v*math.exp(-70*(i/SR))*random.uniform(-1,1) for i in range(int(SR*dur))]
def pad(dur, freqs, v=0.10):
    n=int(SR*dur); o=[0.0]*n
    for i in range(n):
        t=i/SR; trem=0.85+0.15*math.sin(2*math.pi*0.3*t)
        o[i]=v*trem*sum(math.sin(2*math.pi*f*t) for f in freqs)/len(freqs)
    return o

def place(bed, sample, step_sec, step):
    p=int(step*step_sec*SR)
    for i,v in enumerate(sample):
        if p+i < len(bed): bed[p+i]+=v

def loop_fade(bed):
    f=int(SR*0.04)
    for i in range(f):
        bed[i]*=i/f; bed[-1-i]*=i/f
    return bed

def build(bpm, bars, place_fn, pad_freqs=None, padv=0.08, gain=0.5):
    beat=60.0/bpm; step=beat/4; total=int(SR*beat*4*bars)
    bed=[0.0]*total
    if pad_freqs: 
        pd=pad(total/SR, pad_freqs, padv)
        for i in range(min(len(bed),len(pd))): bed[i]+=pd[i]
    place_fn(bed, step, bars)
    return [gain*x for x in loop_fade(bed)]

# DRIVE — energetic four-on-floor (124bpm)
def drive(bed, step, bars):
    k=kick(); oh=hat(0.16,0.20); cl=clap(); ch=hat(0.04,0.14)
    for b in range(bars*4):
        place(bed,k,step,b*4)
        place(bed,ch,step,b*4+2)
        place(bed,oh,step,b*4+2)
        if b%2==1: place(bed,cl,step,b*4)   # clap on beats 2 & 4
save('beat-drive.wav', build(124,4,drive,gain=0.5))

# LOFI — mellow, slow (76bpm), soft + warm pad
def lofi(bed, step, bars):
    k=kick(0.22,90,16); sn=snare(0.16); h=hat(0.05,0.10)
    for b in range(bars*4):
        if b%4 in (0,): place(bed,k,step,b*4)
        if b%4==2: place(bed,[0.6*x for x in sn],step,b*4)
        for s in (1,3): place(bed,h,step,b*4+s)
save('beat-lofi.wav', build(76,4,lofi,pad_freqs=[130.81,196.00,329.63],padv=0.12,gain=0.5))

# TRAP — half-time, fast hats + 808 (140bpm) — youth/tiktok
def trap(bed, step, bars):
    k=kick(0.16,120,24); s8=sub808(0.45); sn=snare(0.22)
    for b in range(bars*4):
        if b%4==0: place(bed,k,step,b*4); place(bed,s8,step,b*4)
        if b%4==2: place(bed,sn,step,b*4)            # snare on beat 3 (half-time)
        for s in range(4):                            # 16th hats, with rolls
            roll = (b%4==3 and s>=2)
            if roll:
                for r in range(3): 
                    p=int(((b*4+s)+r/3.0)*step*SR)
                    h=hat(0.03,0.16)
                    for i,v in enumerate(h):
                        if p+i<len(bed): bed[p+i]+=v
            else:
                place(bed,hat(0.035,0.16),step,b*4+s)
save('beat-trap.wav', build(140,4,trap,gain=0.5))
print("extra beds written")

# ===== CINEMATIC — warm uplifting pad + sub bass + soft pulse (vi-IV-I-V) =====
def _env(n, atk, rel):
    out=[]
    for i in range(n):
        a = min(1.0, i/atk) if atk else 1.0
        r = min(1.0, (n-i)/rel) if rel else 1.0
        out.append(min(a, r))
    return out
def chord(freqs, dur, v=0.16):
    n=int(SR*dur); env=_env(n, int(SR*0.25), int(SR*0.5)); o=[0.0]*n
    for f in freqs:
        for i in range(n):
            t=i/SR
            o[i]+=v*env[i]*(0.7*math.sin(2*math.pi*f*t)+0.3*math.sin(2*math.pi*2*f*t)*0.4)
    return [x/len(freqs) for x in o]
def bassnote(f, dur, v=0.5):
    n=int(SR*dur); env=_env(n,int(SR*0.02),int(SR*0.2))
    return [v*env[i]*math.sin(2*math.pi*f*(i/SR)) for i in range(n)]
def lowpass(sig, a=0.2):
    out=[]; prev=0.0
    for s in sig:
        prev=prev+a*(s-prev); out.append(prev)
    return out
def normalize(sig, peak=0.9):
    m=max(1e-6, max(abs(x) for x in sig)); return [peak*x/m for x in sig]

def cinematic():
    bpm=84; beat=60/bpm; bar=beat*4
    prog=[ [220.0,261.63,329.63,110.0],   # Am  (+root A2)
           [174.61,220.0,261.63,87.31],   # F
           [261.63,329.63,392.0,130.81],  # C
           [196.0,246.94,293.66,98.0] ]   # G
    bars=8; total=int(SR*bar*bars); bed=[0.0]*total
    k=kick(0.2,90,16); sh=hat(0.05,0.07)
    for b in range(bars):
        ch=prog[(b//2)%4]
        cpos=int(b*bar*SR)
        c=chord(ch[:3], bar*0.98, 0.16)
        for i,v in enumerate(c):
            if cpos+i<total: bed[cpos+i]+=v
        bn=bassnote(ch[3], bar*0.98, 0.45)
        for i,v in enumerate(bn):
            if cpos+i<total: bed[cpos+i]+=v
        for be in range(4):                     # soft heartbeat kick + offbeat shaker
            place(bed,[0.5*x for x in k], beat/4, b*16+be*4)
            place(bed,sh, beat/4, b*16+be*4+2)
    bed=lowpass(bed, 0.28)
    return [0.62*x for x in loop_fade(normalize(bed, 0.95))]
save('beat-cinematic.wav', cinematic())
print("cinematic bed written")
