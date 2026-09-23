/**
 * BE Time Picker — Broken English themed time picker.
 * Auto-attaches to all input[type="time"] on the page.
 * Writes back HH:MM (24h) to input.value, fires 'input' + 'change' events.
 * Namespace: window.BETimePicker
 */
(function(){
  'use strict';
  var active=null; // {input, el, overlay, hour12, minute, ampm}

  function pad(n){return n<10?'0'+n:''+n;}

  function to24(h12,ampm){
    if(ampm==='AM') return h12===12?0:h12;
    return h12===12?12:h12+12;
  }
  function to12(h24){
    var ampm=h24>=12?'PM':'AM';
    var h=h24%12; if(h===0) h=12;
    return{h:h,ampm:ampm};
  }

  function parse(val){
    if(!val) return{h:12,m:0,ampm:'AM'};
    var parts=val.split(':');
    var h24=+parts[0], min=+parts[1]||0;
    var r=to12(h24);
    return{h:r.h,m:min,ampm:r.ampm};
  }

  function position(el,anchor){
    var r=anchor.getBoundingClientRect();
    var w=280,h=el.offsetHeight||200;
    var left=r.left;
    var top=r.bottom+4;
    if(left+w>window.innerWidth) left=window.innerWidth-w-8;
    if(left<4) left=4;
    if(top+h>window.innerHeight) top=r.top-h-4;
    if(top<4) top=4;
    el.style.left=left+'px';
    el.style.top=top+'px';
  }

  function fireEvents(input){
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
  }

  function close(){
    if(!active) return;
    if(active.overlay&&active.overlay.parentNode) active.overlay.parentNode.removeChild(active.overlay);
    if(active.el&&active.el.parentNode) active.el.parentNode.removeChild(active.el);
    active=null;
  }

  function applyValue(){
    if(!active) return;
    var h24=to24(active.hour12,active.ampm);
    active.input.value=pad(h24)+':'+pad(active.minute);
    fireEvents(active.input);
  }

  function renderInner(){
    if(!active) return;
    var s=active;
    var h='<div class="be-tp-title">Select Time</div>';
    h+='<div class="be-tp-cols">';
    // Hour
    h+='<div class="be-tp-col"><div class="be-tp-col-label">Hour</div>';
    h+='<button class="be-tp-spin" data-act="h-up">▲</button>';
    h+='<div class="be-tp-val" id="be-tp-hval">'+pad(s.hour12)+'</div>';
    h+='<button class="be-tp-spin" data-act="h-down">▼</button>';
    h+='</div>';
    h+='<div class="be-tp-sep">:</div>';
    // Minute
    h+='<div class="be-tp-col"><div class="be-tp-col-label">Min</div>';
    h+='<button class="be-tp-spin" data-act="m-up">▲</button>';
    h+='<div class="be-tp-val" id="be-tp-mval">'+pad(s.minute)+'</div>';
    h+='<button class="be-tp-spin" data-act="m-down">▼</button>';
    h+='</div>';
    // AM/PM
    h+='<div class="be-tp-ampm" style="margin-top:14px">';
    h+='<button data-act="am" class="'+(s.ampm==='AM'?'active':'')+'">AM</button>';
    h+='<button data-act="pm" class="'+(s.ampm==='PM'?'active':'')+'">PM</button>';
    h+='</div>';
    h+='</div>';
    h+='<div class="be-tp-footer"><button class="be-tp-clear" data-act="clear">Clear</button><button class="be-tp-ok" data-act="ok">Done</button></div>';
    s.el.innerHTML=h;
    position(s.el,s.input);
  }

  function handleAction(act){
    var s=active;
    if(!s) return;
    switch(act){
      case 'h-up': s.hour12=s.hour12>=12?1:s.hour12+1; break;
      case 'h-down': s.hour12=s.hour12<=1?12:s.hour12-1; break;
      case 'm-up': s.minute=s.minute>=59?0:s.minute+1; break;
      case 'm-down': s.minute=s.minute<=0?59:s.minute-1; break;
      case 'am': s.ampm='AM'; break;
      case 'pm': s.ampm='PM'; break;
      case 'clear':
        s.input.value='';
        fireEvents(s.input);
        close(); return;
      case 'ok':
        applyValue();
        close(); return;
    }
    // Update display without full re-render
    var hEl=s.el.querySelector('#be-tp-hval');
    var mEl=s.el.querySelector('#be-tp-mval');
    if(hEl) hEl.textContent=pad(s.hour12);
    if(mEl) mEl.textContent=pad(s.minute);
    var amBtns=s.el.querySelectorAll('.be-tp-ampm button');
    if(amBtns.length===2){
      amBtns[0].className=s.ampm==='AM'?'active':'';
      amBtns[1].className=s.ampm==='PM'?'active':'';
    }
  }

  function open(input){
    if(active&&active.input===input) return;
    close();
    var p=parse(input.value);
    var state={
      input:input,
      hour12:p.h,
      minute:p.m,
      ampm:p.ampm,
      el:null,
      overlay:null
    };
    var overlay=document.createElement('div');
    overlay.className='be-tp-overlay';
    overlay.addEventListener('click',function(e){
      e.stopPropagation();
      applyValue();
      close();
    });
    document.body.appendChild(overlay);
    var el=document.createElement('div');
    el.className='be-tp';
    el.addEventListener('click',function(e){
      var btn=e.target.closest('[data-act]');
      if(!btn) return;
      e.stopPropagation();
      handleAction(btn.getAttribute('data-act'));
    });
    document.body.appendChild(el);
    state.el=el;
    state.overlay=overlay;
    active=state;
    renderInner();
  }

  function attach(input){
    if(input._beTPAttached) return;
    input._beTPAttached=true;
    // Skip readonly time fields (like oto_rec_end)
    if(input.readOnly) return;
    input.addEventListener('click',function(e){
      e.preventDefault();
      e.stopPropagation();
      open(this);
    });
    input.addEventListener('focus',function(e){
      e.preventDefault();
      open(this);
    });
    input.addEventListener('mousedown',function(e){
      e.preventDefault();
      this.blur();
      open(this);
    });
    input.addEventListener('touchstart',function(e){
      e.preventDefault();
      open(this);
    },{passive:false});
  }

  function init(){
    document.querySelectorAll('input[type="time"]').forEach(attach);
    if(window.MutationObserver){
      new MutationObserver(function(mutations){
        mutations.forEach(function(m){
          m.addedNodes.forEach(function(n){
            if(n.nodeType!==1) return;
            if(n.matches&&n.matches('input[type="time"]')) attach(n);
            if(n.querySelectorAll){n.querySelectorAll('input[type="time"]').forEach(attach);}
          });
        });
      }).observe(document.body,{childList:true,subtree:true});
    }
  }

  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&active){applyValue();close();}
  });

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
  else init();

  window.BETimePicker={open:open,close:close,attach:attach};
})();
