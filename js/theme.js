// Dark/light theme toggle. Applies data-theme on <html> synchronously (this
// script must load before the page body, so there's no flash of the wrong
// theme) and persists the choice in localStorage.
(function(){
 var KEY="scan_reader_theme";
 function apply(theme){
  document.documentElement.setAttribute("data-theme",theme);
 }
 var stored=localStorage.getItem(KEY);
 var initial=stored||((window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light");
 apply(initial);

 function wireToggle(){
  var el=document.getElementById("theme-toggle");
  if(!el)return;
  el.checked=document.documentElement.getAttribute("data-theme")==="dark";
  el.addEventListener("change",function(){
   var theme=el.checked?"dark":"light";
   localStorage.setItem(KEY,theme);
   apply(theme);
  });
 }
 if(document.readyState==="loading"){
  document.addEventListener("DOMContentLoaded",wireToggle);
 } else {
  wireToggle();
 }
})();
