/** Reproduces Greenhouse's lazy menus, selected transparent inputs and conditional race question. */
export const demographicFixture = `<section id="demographic-fixture"></section><script>
(() => {
 const root=document.getElementById('demographic-fixture');
 const add=(id,label,choices,initial=[],multi=false)=>{
  const field=document.createElement('div');field.className='field';
  field.innerHTML='<label for="'+id+'">'+label+'</label><div class="select__control"><div data-values></div><input id="'+id+'" role="combobox" aria-controls="'+id+'-listbox"><button type="button" aria-label="Clear selections" data-testid="clear-selection">Clear</button></div><div role="listbox" id="'+id+'-listbox"></div>';
  root.append(field);
  const input=field.querySelector('input'),control=field.querySelector('.select__control'),values=field.querySelector('[data-values]'),list=field.querySelector('[role=listbox]');
  let selected=[...initial];
  const close=()=>list.replaceChildren();
  const render=()=>{values.replaceChildren();for(const value of selected){const chip=document.createElement('span');chip.className=multi?'select__multi-value__label':'select__single-value';chip.textContent=value;values.append(chip);}input.style.opacity=selected.length&&!multi?'0':'1';};
  const open=()=>{close();for(const value of choices.filter(v=>!multi||!selected.includes(v))){const option=document.createElement('div');option.role='option';option.textContent=value;option.onclick=()=>{selected=multi?[...selected,value]:[value];render();close();};list.append(option);}};
  control.addEventListener('mousedown',open);
  field.querySelector('button').onclick=()=>{selected=[];render();close();};
  input.onkeydown=event=>{if(event.key==='Escape')close();};
  render();return field;
 };
 add('demo-gender','How would you describe your gender identity? (mark all that apply)',['Man','Non-binary','Woman',"I don't wish to answer"],["I don't wish to answer"],true);
 add('demo-ethnicity','How would you describe your racial/ethnic background?',['East Asian','South Asian',"I don't wish to answer"],['East Asian'],true);
 add('demo-orientation','How would you describe your sexual orientation?',['Asexual','Gay','Heterosexual',"I don't wish to answer"],["I don't wish to answer"],true);
 add('demo-military','Are you a veteran or active member of the United States Armed Forces?',['Yes, I am a veteran or active member','No, I am not a veteran or active member',"I don't wish to answer"],["I don't wish to answer"]);
 add('demo-sex','Gender',['Male','Female','Decline To Self Identify'],['Decline To Self Identify']);
 add('demo-veteran','Veteran Status',['I am not a protected veteran','I identify as one or more of the classifications of a protected veteran',"I don't wish to answer"],["I don't wish to answer"]);
 const hispanic=document.createElement('div');hispanic.innerHTML='<label for="demo-hispanic">Are you Hispanic/Latino?</label><select id="demo-hispanic"><option value="">Select...</option><option value="yes">Yes</option><option value="no">No</option></select>';root.append(hispanic);
 const race=add('demo-race','Please identify your race',['White','Asian','Black or African American','Decline To Self Identify']);race.style.display='none';
 hispanic.querySelector('select').onchange=()=>{race.style.display='block';};
})();
</script>`;
