// src/pdf.js

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

/**
 * Organiza a solução do GLPK em uma estrutura mais acessível para geração do PDF.
 * @param {Object} solution - Solução retornada pelo GLPK.
 * @param {Object} inputData - Dados de entrada do agendamento.
 * @returns {Object} - Estrutura organizada do agendamento.
 */
function organizeSchedule(solution, inputData) {
  const schedule = {};

  if (!solution.result || !solution.result.vars) {
    return schedule;
  }

  for (const [varName, value] of Object.entries(solution.result.vars)) {
    if (value === 1) {
      // varName no formato x_{DeveloperID}_D{day}_H{hour}
      const regex = /^x_(\d+)_D(\d+)_H(\d+)$/;
      const match = varName.match(regex);
      if (match) {
        const devID = parseInt(match[1], 10);
        const dayNum = parseInt(match[2], 10);
        const hour = parseInt(match[3], 10);

        if (!schedule[devID]) {
          schedule[devID] = {};
        }

        const dayName = [
          "Segunda",
          "Terça",
          "Quarta",
          "Quinta",
          "Sexta",
          "Sábado",
          "Domingo",
        ][dayNum - 1];

        if (!schedule[devID][dayName]) {
          schedule[devID][dayName] = [];
        }

        schedule[devID][dayName].push(hour);
      }
    }
  }

  return schedule;
}

/**
 * Gera um relatório em PDF com as escalas dos desenvolvedores.
 * @param {Object} solution - Solução retornada pelo GLPK.
 * @param {Object} inputData - Dados de entrada do agendamento.
 */
function generatePDFReport(solution, inputData) {
  const doc = new PDFDocument({ margin: 30, size: "A4" });
  const outputPath = path.join(__dirname, "..", "schedule_report.pdf");
  const writeStream = fs.createWriteStream(outputPath);
  doc.pipe(writeStream);

  // Título do Relatório
  doc.fontSize(20).text("Relatório de Escalas", { align: "center" });
  doc.moveDown();

  // Informações do Período
  doc
    .fontSize(14)
    .text(`Mês: ${inputData.scheduling_period.month}`, { align: "left" });
  doc.moveDown();

  // Organizar a solução em uma estrutura mais acessível
  const schedule = organizeSchedule(solution, inputData);

  // Obter todos os dias do mês para iterar
  const [year, month] = inputData.scheduling_period.month
    .split("-")
    .map(Number);
  const numDays = new Date(year, month, 0).getDate();

  // Função para obter o nome do dia da semana para uma data específica
  function getDayName(year, month, day) {
    const date = new Date(year, month - 1, day);
    const dayIndex = date.getDay(); // 0 (Domingo) a 6 (Sábado)
    return [
      "Domingo",
      "Segunda",
      "Terça",
      "Quarta",
      "Quinta",
      "Sexta",
      "Sábado",
    ][dayIndex];
  }

  // Iterar por cada dia do mês
  for (let day = 1; day <= numDays; day++) {
    const dayName = getDayName(year, month, day);

    doc.fontSize(16).text(`Dia ${day} (${dayName})`, { underline: true });
    doc.fontSize(12).text("Horário Comercial:", { bold: true });

    // Listar desenvolvedores alocados no horário comercial
    developers = inputData.developers.filter(
      (dev) =>
        dev.Level !== "Junior" ||
        (dev.Level === "Junior" &&
          dayName !== "Sábado" &&
          dayName !== "Domingo")
    );
    let commercialWorkers = [];

    inputData.developers.forEach((dev) => {
      if (schedule[dev.DeveloperID] && schedule[dev.DeveloperID][dayName]) {
        schedule[dev.DeveloperID][dayName].forEach((hour) => {
          if (hour >= 8 && hour < 17) {
            commercialWorkers.push({ dev, hour });
          }
        });
      }
    });

    // Agrupar por desenvolvedor
    let commercialByDev = {};
    commercialWorkers.forEach((entry) => {
      const devName = entry.dev.Name;
      if (!commercialByDev[devName]) {
        commercialByDev[devName] = [];
      }
      commercialByDev[devName].push(entry.hour);
    });

    for (const [devName, hours] of Object.entries(commercialByDev)) {
      const hoursStr = hours
        .sort((a, b) => a - b)
        .map((h) => `${h}:00`)
        .join(", ");
      doc.text(`- ${devName}: ${hoursStr}`);
    }

    // Listar sobreaviso
    doc.fontSize(12).text("Sobreaviso:", { bold: true });

    // Turnos de Sobreaviso: 00:00-08:00 e 17:00-23:59
    let onCallWorkers = [];

    inputData.developers.forEach((dev) => {
      if (dev.Level === "Sênior" || dev.Level === "Pleno") {
        if (schedule[dev.DeveloperID] && schedule[dev.DeveloperID][dayName]) {
          schedule[dev.DeveloperID][dayName].forEach((hour) => {
            if ((hour >= 0 && hour < 8) || (hour >= 17 && hour < 24)) {
              onCallWorkers.push({ dev, hour });
            }
          });
        }
      }
    });

    // Agrupar por turno
    let onCallByShift = {
      "00:00-08:00": [],
      "17:00-23:59": [],
    };

    onCallWorkers.forEach((entry) => {
      if (entry.hour >= 0 && entry.hour < 8) {
        onCallByShift["00:00-08:00"].push(entry.dev.Name);
      }
      if (entry.hour >= 17 && entry.hour < 24) {
        onCallByShift["17:00-23:59"].push(entry.dev.Name);
      }
    });

    for (const [shift, devNames] of Object.entries(onCallByShift)) {
      if (devNames.length > 0) {
        doc.text(`- ${shift}: ${[...new Set(devNames)].join(", ")}`);
      } else {
        doc.text(`- ${shift}: Nenhum`);
      }
    }

    doc.moveDown();
  }

  // Cálculo de horas e custos
  const totalHours = {};
  const totalCost = {};

  inputData.developers.forEach((dev) => {
    totalHours[dev.Name] = 0;
    totalCost[dev.Name] = 0;
  });

  for (const [devID, days] of Object.entries(schedule)) {
    const dev = inputData.developers.find(
      (d) => d.DeveloperID === parseInt(devID, 10)
    );
    if (!dev) continue;

    for (const [day, hours] of Object.entries(days)) {
      hours.forEach((hour) => {
        if (hour >= 8 && hour < 17) {
          totalHours[dev.Name] += 1;
          totalCost[dev.Name] += dev.CostPerHour;
        } else {
          // Sobreaviso
          totalHours[dev.Name] += 1;
          if (hour >= 17 && hour < 24) {
            totalCost[dev.Name] += dev.CostPerHour * 0.5; // Sobreaviso
          } else if (hour >= 0 && hour < 8) {
            totalCost[dev.Name] += dev.CostPerHour * 1.5; // Hora extra
          }
        }
      });
    }
  }

  // Informações Finais
  doc.addPage();
  doc.fontSize(16).text("Resumo Mensal", { underline: true });
  doc.moveDown();

  inputData.developers.forEach((dev) => {
    doc.fontSize(14).text(`Desenvolvedor: ${dev.Name} (${dev.Level})`);
    doc.fontSize(12).text(`- Horas Trabalhadas: ${totalHours[dev.Name]}`);
    doc
      .fontSize(12)
      .text(`- Total a Pagar: R$ ${totalCost[dev.Name].toFixed(2)}`);
    doc.moveDown();
  });

  // Total Geral
  let geralHoras = 0;
  let geralCusto = 0;

  Object.values(totalHours).forEach((h) => {
    geralHoras += h;
  });

  Object.values(totalCost).forEach((c) => {
    geralCusto += c;
  });

  doc.fontSize(16).text("Total Geral", { underline: true });
  doc.moveDown();
  doc.fontSize(12).text(`- Horas Totais: ${geralHoras}`);
  doc.fontSize(12).text(`- Custo Total: R$ ${geralCusto.toFixed(2)}`);

  // Finalizar o PDF
  doc.end();
  console.log(`Relatório gerado em: ${outputPath}`);
}

module.exports = { generatePDFReport };
