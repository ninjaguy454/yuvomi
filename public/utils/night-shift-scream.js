/* Original local vocal/mechanical synthesis; no recorded or downloaded audio. */
  function createScreamSamples(sampleRate=22050){
    const data=new Float32Array(sampleRate);let phase=0,seed=8547,peak=0;
    for(let i=0;i<data.length;i++){
      const t=i/sampleRate;
      seed=(1664525*seed+1013904223)>>>0;
      const noise=(seed/4294967296)*2-1;
      const pitch=210+380*Math.sin(Math.PI*t)**.55+22*Math.sin(t*2*Math.PI*39);
      phase+=pitch/sampleRate;
      const glottal=Math.sin(phase*Math.PI*2)+.52*Math.sin(phase*Math.PI*4)+.3*Math.sin(phase*Math.PI*6);
      const vowel=(Math.sin(2*Math.PI*(780*t+160*t*t))*.52+Math.sin(2*Math.PI*(1950*t+340*t*t))*.24+Math.sin(2*Math.PI*3120*t)*.1);
      const envelope=Math.min(1,t/.025)*Math.min(1,(1-t)/.22)*(.78+.22*Math.sin(Math.PI*t));
      const value=Math.tanh((glottal*.54+vowel*.55+noise*.18)*1.4)*envelope;
      data[i]=value;peak=Math.max(peak,Math.abs(value));
    }
    for(let i=0;i<data.length;i++)data[i]*=.84/peak;
    data[0]=0;data[data.length-1]=0;return data;
  }

export {createScreamSamples};
