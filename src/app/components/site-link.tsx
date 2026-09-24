import {useNavigate} from '@tanstack/react-router';
import type {AnchorHTMLAttributes,MouseEvent} from 'react';
type Props=AnchorHTMLAttributes<HTMLAnchorElement>&{href:string};
export default function SiteLink({href,onClick,...props}:Props){
 const navigate=useNavigate();
 function go(event:MouseEvent<HTMLAnchorElement>){
  onClick?.(event);
  if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||(props.target&&props.target!=='_self')||props.download)return;
  const target=new URL(href,window.location.href);
  if(target.origin!==window.location.origin)return;
  event.preventDefault();
  if(target.pathname!==window.location.pathname)window.dispatchEvent(new CustomEvent('arclite:navigate',{detail:target.pathname}));
  void navigate({to:target.pathname,hash:target.hash.slice(1)}).catch(()=>window.location.assign(target.href));
 }
 return <a {...props} href={href} onClick={go}/>;
}
