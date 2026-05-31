#!/usr/bin/env python3
"""Synthesize royalty-free SFX + a light beat bed for the Razoryn videos.
Pure Python (wave + math) — no deps, no licensing. Run: python3 gen_audio.py
Outputs 44.1kHz 16-bit mono WAVs into public/audio/.
"""
import wave, math, struct, random, os
SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public', 'audio')
os.makedirs(OUT, exist_ok=True)

def save(name, samples):
    path = os.path.join(OUT, name)
    with wave.open(path, 'w') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        frames = bytearray()
        for s in samples:
            v = int(max(-1.0, min(1.0, s)) * 32767)
            frames += struct.pack('<h', v)
        w.writeframes(frames)
    print(f"  {name}  ({len(samples)/SR:.2f}s)")

def tone(freq, dur, vol=0.5, decay=8.0, harm=0.0):
    n = int(SR * dur); out = []
    for i in range(n):
        t = i / SR
        env = math.exp(-decay * t)
        s = math.sin(2*math.pi*freq*t)
        if harm: s += harm * math.sin(2*math.pi*freq*2*t)
        out.append(vol * env * s / (1+harm))
    return out

def mix(*tracks):
    n = max(len(t) for t in tracks); out = [0.0]*n
    for t in tracks:
        for i, s in enumerate(t): out[i] += s
    return out

def at(track, start, total):
    out = [0.0]*total
    for i, s in enumerate(track):
        if start+i < total: out[start+i] += s
    return out

# --- doorbell: classic ding–dong (E5 then C5) ---
ding = tone(659.25, 0.6, 0.55, decay=4.5, harm=0.3)
dong = tone(523.25, 0.9, 0.55, decay=3.5, harm=0.3)
total = int(SR*1.7)
save('doorbell.wav', [a+b for a,b in zip(at(ding,0,total), at(dong,int(SR*0.55),total))])

# --- tap (UI click) ---
save('tap.wav', tone(1100, 0.06, 0.5, decay=40, harm=0.5))

# --- pop ---
pop = []
n=int(SR*0.12)
for i in range(n):
    t=i/SR; f=200+700*(t/0.12); pop.append(0.5*math.exp(-18*t)*math.sin(2*math.pi*f*t))
save('pop.wav', pop)

# --- whoosh (noise swept by an amplitude bell) ---
n=int(SR*0.5); wh=[]
prev=0.0
for i in range(n):
    t=i/SR
    env=math.sin(math.pi*t/0.5)**2
    noise=random.uniform(-1,1)
    prev=0.85*prev+0.15*noise   # crude low-pass
    wh.append(0.45*env*prev)
save('whoosh.wav', wh)

# --- success chime (C5-E5-G5 quick arpeggio) ---
total=int(SR*1.0)
ch=mix(at(tone(523.25,0.5,0.4,6,0.3),0,total),
       at(tone(659.25,0.5,0.4,6,0.3),int(SR*0.10),total),
       at(tone(783.99,0.7,0.45,5,0.3),int(SR*0.20),total))
save('chime.wav', ch)

# --- beat bed: ~8s loop, kick (4-on-floor) + offbeat hat, low level ---
bpm=120; beat=60.0/bpm; bars=4; total=int(SR*beat*4*bars)
def kick(dur=0.18):
    n=int(SR*dur); o=[]
    for i in range(n):
        t=i/SR; f=110*math.exp(-22*t)+45
        o.append(0.7*math.exp(-9*t)*math.sin(2*math.pi*f*t))
    return o
def hat(dur=0.05):
    n=int(SR*dur); return [0.18*math.exp(-60*(i/SR))*random.uniform(-1,1) for i in range(n)]
bed=[0.0]*total
k=kick(); h=hat()
step=beat/2  # eighth notes
nsteps=int(bars*4*2)
for s in range(nsteps):
    pos=int(s*step*SR)
    if s%2==0:  # on the beat -> kick
        for i,v in enumerate(k):
            if pos+i<total: bed[pos+i]+=v
    else:       # offbeat -> hat
        for i,v in enumerate(h):
            if pos+i<total: bed[pos+i]+=v
# gentle fade in/out for clean looping
fade=int(SR*0.05)
for i in range(fade):
    bed[i]*=i/fade; bed[total-1-i]*=i/fade
save('beat.wav', [0.5*x for x in bed])

print("audio written to public/audio/")
