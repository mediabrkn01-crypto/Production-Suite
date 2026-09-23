/**
 * BE Date Picker — Broken English themed date picker.
 * Auto-attaches to all input[type="date"] on the page.
 * Writes back ISO (YYYY-MM-DD) to input.value, fires 'input' + 'change' events.
 * Namespace: window.BEDatePicker
 */
(function(){
  'use strict';
  var MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
  var MONTHS_SHORT=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var DAYS=['S','M','T','W','T','F','S'];
  var active=null; // {input, el, overlay, view, viewYear, viewMonth, selectedISO}

  function pad(n){return n<10?'0'+n:''+n;}
  function toISO(y,m,d){return y+'-'+pad(m+1)+'-'+pad(d);}
  function parseISO(s){if(!s)return null;var p=s.split('-');return{y:+p[0],m:+p[1]-1,d:+p[2]};}
  function daysInMonth(y,m){return new Date(y,m+1,0).getDate();}
  function firstDayOfMonth(y,m){return new Date(y,m,1).getDay();}
  function todayISO(){return new Date().toISOString().slice(0,10);}

  function position(el,anchor){
    var r=anchor.getBoundingClientRect();
    var w=320,h=el.offsetHeight||360;
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

  function render(){
    if(!active) return;
    var s=active;
    var html='';
    if(s.view==='days'){
      html+=renderDaysView();
    } else if(s.view==='months'){
      html+=renderMonthsView();
    } else if(s.view==='years'){
      html+=renderYearsView();
    }
    s.el.innerHTML=html;
    position(s.el,s.input);
    bindEvents();
  }

  function renderDaysView(){
    var s=active,y=s.viewYear,m=s.viewMonth;
    var sel=parseISO(s.selectedISO);
    var tod=todayISO();
    var dim=daysInMonth(y,m);
    var fdow=firstDayOfMonth(y,m);
    var prevDim=daysInMonth(y,m===0?11:m-1);
    var h='<div class="be-dp-header">';
    h+='<button class="be-dp-nav" data-act="prev-month">‹</button>';
    h+='<div class="be-dp-title"><button data-act="show-months">'+MONTHS[m]+'</button><button data-act="show-years">'+y+'</button></div>';
    h+='<button class="be-dp-nav" data-act="next-month">›</button>';
    h+='</div>';
    h+='<div class="be-dp-weekdays">';
    DAYS.forEach(function(d){h+='<span>'+d+'</span>';});
    h+='</div>';
    h+='<div class="be-dp-days">';
    // prev month fill
    for(var i=0;i<fdow;i++){
      var pd=prevDim-fdow+1+i;
      var py=m===0?y-1:y, pm=m===0?11:m-1;
      var iso=toISO(py,pm,pd);
      h+='<button class="be-dp-day other" data-date="'+iso+'">'+pd+'</button>';
    }
    // current month
    for(var d=1;d<=dim;d++){
      var iso=toISO(y,m,d);
      var cls='be-dp-day';
      if(iso===tod) cls+=' today';
      if(sel&&iso===s.selectedISO) cls+=' selected';
      h+='<button class="'+cls+'" data-date="'+iso+'">'+d+'</button>';
    }
    // next month fill
    var totalCells=fdow+dim;
    var rem=totalCells%7===0?0:7-totalCells%7;
    for(var i=1;i<=rem;i++){
      var ny=m===11?y+1:y, nm=m===11?0:m+1;
      var iso=toISO(ny,nm,i);
      h+='<button class="be-dp-day other" data-date="'+iso+'">'+i+'</button>';
    }
    h+='</div>';
    h+='<div class="be-dp-footer"><button class="be-dp-clear" data-act="clear">Clear</button><button class="be-dp-today" data-act="today">Today</button></div>';
    return h;
  }

  function renderMonthsView(){
    var s=active;
    var h='<div class="be-dp-header">';
    h+='<button class="be-dp-nav" data-act="prev-year">‹</button>';
    h+='<div class="be-dp-title"><button data-act="show-years">'+s.viewYear+'</button></div>';
    h+='<button class="be-dp-nav" data-act="next-year">›</button>';
    h+='</div>';
    h+='<div class="be-dp-grid">';
    var sel=parseISO(s.selectedISO);
    var now=new Date();
    for(var i=0;i<12;i++){
      var cls='';
      if(now.getFullYear()===s.viewYear&&now.getMonth()===i) cls='current';
      if(sel&&sel.y===s.viewYear&&sel.m===i) cls='selected';
      h+='<button class="'+cls+'" data-act="pick-month" data-month="'+i+'">'+MONTHS_SHORT[i]+'</button>';
    }
    h+='</div>';
    return h;
  }

  function renderYearsView(){
    var s=active;
    var centerYear=s.viewYear;
    var startYear=centerYear-50;
    var endYear=centerYear+20;
    var h='<div class="be-dp-header">';
    h+='<div class="be-dp-title" style="justify-content:flex-start"><button data-act="show-days" style="font-size:12px;color:rgba(255,255,255,.5)">← Back</button></div>';
    h+='</div>';
    h+='<div class="be-dp-ysearch"><input type="text" placeholder="Search year…" data-act="year-search" autocomplete="off"/></div>';
    h+='<div class="be-dp-ylist"><div class="be-dp-grid" id="be-dp-year-grid">';
    var sel=parseISO(s.selectedISO);
    var now=new Date();
    for(var y=endYear;y>=startYear;y--){
      var cls='';
      if(y===now.getFullYear()) cls='current';
      if(sel&&sel.y===y) cls='selected';
      h+='<button class="'+cls+'" data-act="pick-year" data-year="'+y+'">'+y+'</button>';
    }
    h+='</div></div>';
    return h;
  }

  function bindEvents(){
    if(!active) return;
    var el=active.el;
    el.addEventListener('click',function(e){
      var btn=e.target.closest('[data-act]');
      if(!btn) return;
      e.stopPropagation();
      var act=btn.getAttribute('data-act');
      handleAction(act,btn);
    });
    var searchInput=el.querySelector('[data-act="year-search"]');
    if(searchInput){
      searchInput.addEventListener('input',function(){
        var q=this.value.trim();
        var btns=el.querySelectorAll('[data-act="pick-year"]');
        btns.forEach(function(b){
          b.style.display=!q||b.getAttribute('data-year').indexOf(q)!==-1?'':'none';
        });
      });
      setTimeout(function(){searchInput.focus();},50);
      // scroll selected year into view
      var selBtn=el.querySelector('[data-act="pick-year"].selected')||el.querySelector('[data-act="pick-year"].current');
      if(selBtn){setTimeout(function(){selBtn.scrollIntoView({block:'center',behavior:'auto'});},60);}
    }
  }

  function handleAction(act,btn){
    var s=active;
    if(!s) return;
    switch(act){
      case 'prev-month':
        if(s.viewMonth===0){s.viewMonth=11;s.viewYear--;}else s.viewMonth--;
        render(); break;
      case 'next-month':
        if(s.viewMonth===11){s.viewMonth=0;s.viewYear++;}else s.viewMonth++;
        render(); break;
      case 'prev-year':
        s.viewYear--; render(); break;
      case 'next-year':
        s.viewYear++; render(); break;
      case 'show-months':
        s.view='months'; render(); break;
      case 'show-years':
        s.view='years'; render(); break;
      case 'show-days':
        s.view='days'; render(); break;
      case 'pick-month':
        s.viewMonth=+btn.getAttribute('data-month');
        s.view='days'; render(); break;
      case 'pick-year':
        s.viewYear=+btn.getAttribute('data-year');
        s.view='months'; render(); break;
      case 'clear':
        s.selectedISO='';
        s.input.value='';
        fireEvents(s.input);
        close(); break;
      case 'today':
        var t=todayISO();
        s.selectedISO=t;
        s.input.value=t;
        var p=parseISO(t); s.viewYear=p.y; s.viewMonth=p.m;
        fireEvents(s.input);
        close(); break;
    }
    // date pick
    var dateVal=btn.getAttribute('data-date');
    if(dateVal){
      s.selectedISO=dateVal;
      s.input.value=dateVal;
      var p=parseISO(dateVal); s.viewYear=p.y; s.viewMonth=p.m;
      fireEvents(s.input);
      close();
    }
  }

  function open(input){
    if(active&&active.input===input) return;
    close();
    var val=input.value||'';
    var parsed=parseISO(val);
    var now=new Date();
    var state={
      input:input,
      selectedISO:val,
      viewYear:parsed?parsed.y:now.getFullYear(),
      viewMonth:parsed?parsed.m:now.getMonth(),
      view:'days',
      el:null,
      overlay:null
    };
    var overlay=document.createElement('div');
    overlay.className='be-dp-overlay';
    overlay.addEventListener('click',function(e){e.stopPropagation();close();});
    document.body.appendChild(overlay);
    var el=document.createElement('div');
    el.className='be-dp';
    document.body.appendChild(el);
    state.el=el;
    state.overlay=overlay;
    active=state;
    render();
  }

  function attach(input){
    if(input._beDPAttached) return;
    input._beDPAttached=true;
    input.addEventListener('click',function(e){
      e.preventDefault();
      e.stopPropagation();
      open(this);
    });
    input.addEventListener('focus',function(e){
      e.preventDefault();
      open(this);
    });
    // prevent native picker
    input.addEventListener('mousedown',function(e){
      e.preventDefault();
      this.blur();
      open(this);
    });
  }

  function init(){
    document.querySelectorAll('input[type="date"]').forEach(attach);
    // watch for dynamically added inputs
    if(window.MutationObserver){
      new MutationObserver(function(mutations){
        mutations.forEach(function(m){
          m.addedNodes.forEach(function(n){
            if(n.nodeType!==1) return;
            if(n.matches&&n.matches('input[type="date"]')) attach(n);
            if(n.querySelectorAll){n.querySelectorAll('input[type="date"]').forEach(attach);}
          });
        });
      }).observe(document.body,{childList:true,subtree:true});
    }
  }

  // Escape key
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&active) close();
  });

  // Init on DOMContentLoaded or immediately
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
  else init();

  window.BEDatePicker={open:open,close:close,attach:attach};
})();
