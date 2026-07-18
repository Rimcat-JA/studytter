import { sampleBeta,updateArm } from '../src/core/bandit';import { updateIrt } from '../src/core/irt';
const rewards=[.2,.55,.85];let arms=rewards.map(()=>({alpha:1,beta:1}));let ability={theta:0,attempts:0};let difficulty=0;
for(let round=0;round<5000;round++){const draws=arms.map(a=>sampleBeta(a.alpha,a.beta));const choice=draws.indexOf(Math.max(...draws));const reward=Math.random()<rewards[choice]?1:0;arms[choice]=updateArm(arms[choice],reward);const correct=Math.random()<1/(1+Math.exp(-(ability.theta-difficulty)));const next=updateIrt(ability,difficulty,correct);ability=next.state;difficulty=next.difficultyB}
console.log(JSON.stringify({arms:arms.map((a,i)=>({trueReward:rewards[i],posteriorMean:a.alpha/(a.alpha+a.beta),pulls:a.alpha+a.beta-2})),ability,difficulty},null,2));
