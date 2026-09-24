import {createFileRoute} from '@tanstack/react-router';
import Page from '../app/page';
export const Route=createFileRoute('/')({head:()=>({meta:[{title:"ArcLite \u2014 Private Execution. Real-World Value."}]}),component:Page});
