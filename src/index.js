// src/index.js

const fs = require("fs");
const path = require("path");
const glpkModule = require("glpk.js");
const { generatePDFReport } = require("./pdf");

// Função para ler e parsear o JSON de entrada
function readInputData(filePath) {
  const data = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(data);
}

// Função para gerar o modelo GLPK
function generateGLPKModel(inputData, GLPK) {
  const {
    developers,
    weekly_constraints,
    constraints_rules,
    additional_constraints,
    deploys,
  } = inputData;

  // Definir as variáveis de decisão
  // x_{DeveloperID}_{Day}_{Hour} = 1 se o desenvolvedor está trabalhando naquela hora, 0 caso contrário

  // Mapeamento de dias para números
  const dayNames = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  const dayToNumber = {};
  dayNames.forEach((day, index) => {
    dayToNumber[day] = index + 1;
  });

  let variables = [];
  let objectiveVars = [];
  let objectiveCoefficients = [];

  // Função para verificar se um desenvolvedor pode trabalhar em determinado dia e hora
  function canWork(dev, day, hour) {
    // Verificar restrições de júnior
    if (dev.Level === "Junior") {
      if (day > 5) {
        // Sábado e Domingo
        return false;
      }
      if (hour < 8 || hour >= 17) {
        // Fora do horário comercial
        return false;
      }
    }
    return true;
  }

  // Coletar todas as variáveis e seus coeficientes
  developers.forEach((dev) => {
    const wc = weekly_constraints.find(
      (wc) => wc.DeveloperID === dev.DeveloperID
    );
    if (!wc) {
      throw new Error(
        `Weekly constraints not found for DeveloperID: ${dev.DeveloperID}`
      );
    }

    for (let day = 1; day <= 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        if (canWork(dev, day, hour)) {
          const varName = `x_${dev.DeveloperID}_D${day}_H${hour}`;
          variables.push(varName);
          objectiveVars.push(varName);
          objectiveCoefficients.push(dev.CostPerHour);
        }
      }
    }
  });

  // Definir a função objetivo
  const model = {
    name: "Developer Scheduling",
    objective: {
      direction: GLPK.GLP_MIN, // Correção: Usar GLP_MIN para minimizar custos
      name: "Total_Cost",
      vars: [],
      bnds: {
        type: GLPK.GLP_FX,
        lb: 0,
        ub: 0,
      },
    },
    subjectTo: [],
    binaries: variables, // Variáveis binárias
    generals: [],
  };

  // Adicionar as variáveis e coeficientes à função objetivo
  objectiveVars.forEach((varName, index) => {
    model.objective.vars.push({
      name: varName,
      coef: objectiveCoefficients[index],
    });
  });

  // Adicionar restrições

  // 1. Cobertura 24x7: cada hora deve ter pelo menos um desenvolvedor trabalhando
  for (let day = 1; day <= 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      let constraint = {
        name: `coverage_D${day}_H${hour}`,
        vars: [],
        bnds: {
          type: GLPK.GLP_LO,
          lb: 1,
          ub: 0,
        },
      };

      developers.forEach((dev) => {
        if (canWork(dev, day, hour)) {
          const varName = `x_${dev.DeveloperID}_D${day}_H${hour}`;
          constraint.vars.push({ name: varName, coef: 1 });
        }
      });

      model.subjectTo.push(constraint);
    }
  }

  // 2. Cada desenvolvedor deve ter entre 40 e 52 horas semanais
  developers.forEach((dev) => {
    const wc = weekly_constraints.find(
      (wc) => wc.DeveloperID === dev.DeveloperID
    );
    if (!wc) {
      throw new Error(
        `Weekly constraints not found for DeveloperID: ${dev.DeveloperID}`
      );
    }

    let sumHours = {
      name: `sum_hours_dev_${dev.DeveloperID}`,
      vars: [],
      bnds: {
        type: GLPK.GLP_DB,
        lb: wc.MinimumWeeklyHours,
        ub: wc.MaximumWeeklyHours,
      },
    };

    for (let day = 1; day <= 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        if (canWork(dev, day, hour)) {
          const varName = `x_${dev.DeveloperID}_D${day}_H${hour}`;
          sumHours.vars.push({ name: varName, coef: 1 });
        }
      }
    }

    model.subjectTo.push(sumHours);
  });

  // 3. Cobertura durante Horas Ativas (08h às 17h, Segunda a Sexta)
  // Pelo menos 2 plenos ou 1 sênior durante as horas ativas
  for (let day = 1; day <= 5; day++) {
    // Segunda a Sexta
    for (let hour = 8; hour < 17; hour++) {
      // 08h às 17h
      let constraint = {
        name: `active_coverage_D${day}_H${hour}`,
        vars: [],
        bnds: {
          type: GLPK.GLP_LO,
          lb: 2,
          ub: 0,
        },
      };

      developers.forEach((dev) => {
        if (dev.Level === "Pleno" || dev.Level === "Sênior") {
          const varName = `x_${dev.DeveloperID}_D${day}_H${hour}`;
          constraint.vars.push({ name: varName, coef: 1 });
        }
      });

      model.subjectTo.push(constraint);
    }
  }

  // 4. Finais de Semana: 1 desenvolvedor por dia (24h)
  for (let day = 6; day <= 7; day++) {
    // Sábado e Domingo
    for (let hour = 0; hour < 24; hour++) {
      let constraint = {
        name: `weekend_coverage_D${day}_H${hour}`,
        vars: [],
        bnds: {
          type: GLPK.GLP_LO,
          lb: 1,
          ub: 0,
        },
      };

      developers.forEach((dev) => {
        // Desenvolvedores juniores não podem trabalhar nos finais de semana
        if (dev.Level !== "Junior") {
          const varName = `x_${dev.DeveloperID}_D${day}_H${hour}`;
          constraint.vars.push({ name: varName, coef: 1 });
        }
      });

      model.subjectTo.push(constraint);
    }
  }

  // Outras restrições podem ser adicionadas aqui conforme necessário

  return model;
}

// Função para resolver o modelo GLPK
async function solveGLPKModel(model, GLPK) {
  try {
    const result = GLPK.solve(model, GLPK.GLP_MSG_OFF);
    return result;
  } catch (error) {
    console.error("Erro ao resolver o modelo GLPK:", error);
    throw error;
  }
}

// Função principal
async function main() {
  try {
    const inputFilePath = path.join(__dirname, "input_data.json");
    const inputData = readInputData(inputFilePath);

    const GLPK = await glpkModule(); // Inicializa o GLPK

    const model = generateGLPKModel(inputData, GLPK);

    console.log("Modelo GLPK gerado.");

    const solution = await solveGLPKModel(model, GLPK);

    if (solution.result.status === GLPK.GLP_OPT) {
      console.log("Solução ótima encontrada.");
      generatePDFReport(solution, inputData);
    } else {
      console.log("Não foi possível encontrar uma solução ótima.");
      // Opcional: detalhar o status
      console.log(`Status da solução: ${solution.result.status}`);
    }
  } catch (error) {
    console.error("Erro:", error);
  }
}

main();
